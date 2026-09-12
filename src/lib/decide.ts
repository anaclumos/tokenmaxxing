import { z } from "zod";
import { withLock } from "./lock.ts";
import { POST_SWAP_COOLDOWN_MS, loadAccounts, loadConfig, loadDepletedWait, loadLastSwapAt, saveAccounts, saveDepletedWait } from "./state.ts";
import { isExhausted, limitWindows, nextWeeklyReset, pickBest, pickEarliestReset, sessionWindow, thresholdBars, usableAt, weeklyWindow, type PickCtx } from "./picker.ts";
import { familyTokens } from "./usage.ts";
import { log } from "./log.ts";
import type { Observation, Provider } from "./provider.ts";
import { AccountSchema, type Account, type EnforcedLimit } from "./types.ts";

const SwapDecisionSchema = z.object({
  swapped: z.boolean(),
  account: AccountSchema.nullable(),
  reason: z.string(),
  waitUntil: z.number().optional(),
});
export type SwapDecision = z.infer<typeof SwapDecisionSchema>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

function isOver(account: Account | undefined, observed: Observation | null, ctx: PickCtx): boolean {
  if (!account) return false;
  if (account.needsReauth === true) return true;
  if (account.enforcedUntil != null && account.enforcedUntil > ctx.now) return true;
  if (!observed) return false;
  return isExhausted({ ...account, windows: observed.windows }, ctx);
}

function enforcedWall(limit: EnforcedLimit, account: Account, now: number): number {
  const { family } = limit;
  const familyReset =
    family == null
      ? null
      : limitWindows(account)
          .filter((w) => familyTokens(w.name ?? "").includes(family))
          .map((w) => w.resetsAt)
          .find((r): r is number => r != null) ?? null;
  const session = sessionWindow(account)?.resetsAt ?? null;
  const cachedReset =
    limit.kind === "session"
      ? session != null && session > now ? session : null
      : nextWeeklyReset(familyReset ?? weeklyWindow(account)?.resetsAt ?? null, now);
  return limit.resetsAt ?? cachedReset ?? now + (limit.kind === "session" ? FIVE_HOURS_MS : WEEK_MS);
}

export async function evaluateAndMaybeSwap(p: Provider, now = Date.now(), anticipatory = false, enforced: EnforcedLimit | null = null): Promise<SwapDecision> {
  const activeId = p.liveId();

  const lastSwapAt = loadLastSwapAt(p.pool);
  if (!enforced && lastSwapAt != null && now - lastSwapAt < POST_SWAP_COOLDOWN_MS) {
    return depletedReplay(p, now) ?? { swapped: false, account: null, reason: "post-swap-cooldown" };
  }

  const cfg = loadConfig();
  const bars = thresholdBars(cfg);
  const stored0 = loadAccounts(p.pool).accounts.find((a) => a.id === activeId);
  const walled0 = stored0?.enforcedUntil != null && stored0.enforcedUntil > now;
  const observed = stored0 ? await p.observeLive(stored0, cfg, now, { probe: enforced == null && !walled0 }) : null;
  const stored = loadAccounts(p.pool).accounts.find((a) => a.id === activeId);

  if (!enforced && !isOver(stored, observed, { now, thresholds: bars, currentId: activeId, families: p.gatedFamilies(cfg) })) {
    if (!observed) {
      const replay = depletedReplay(p, now);
      if (replay) return replay;
    }
    return { swapped: false, account: null, reason: "under-threshold-or-stale" };
  }

  return withLock(p.pool.lockFile, async () => {
    const lastSwapAt2 = loadLastSwapAt(p.pool);
    if (!enforced && lastSwapAt2 != null && now - lastSwapAt2 < POST_SWAP_COOLDOWN_MS) {
      return { swapped: false, account: null, reason: "raced-already-swapped" };
    }
    const idx = loadAccounts(p.pool);
    const id2 = p.liveId();
    const active = id2 ? idx.accounts.find((a) => a.id === id2) : undefined;

    const origin = enforced ? idx.accounts.find((a) => a.id === enforced.account) : undefined;
    const prior = origin?.enforcedUntil != null && origin.enforcedUntil > now;
    if (enforced && origin) {
      origin.enforcedUntil = Math.max(origin.enforcedUntil ?? 0, enforcedWall(enforced, origin, now));
      origin.lastProbeAt = now;
      saveAccounts(p.pool, idx);
      log("usage.enforced_limit", { kind: enforced.kind, family: enforced.family ?? undefined, resetsAt: origin.enforcedUntil, blind: prior || enforced.blind, live: origin === active });
    }
    const enforced2 = enforced && origin && origin === active ? enforced : null;

    if (id2 != null && !active) {
      return { swapped: false, account: null, reason: "live-credential-not-in-pool" };
    }

    const obs2 = active ? await p.observeLive(active, cfg, now, { probe: false }) : null;
    if (active && obs2 && (active.lastUsageAt == null || obs2.at > active.lastUsageAt)) {
      active.windows = p.mergeWindows(obs2.windows, active.windows);
      active.lastUsageAt = obs2.at;
      saveAccounts(p.pool, idx);
    }

    const families = p.gatedFamilies(cfg);
    const walled = active?.enforcedUntil != null && active.enforcedUntil > now;
    const blindScreen = (enforced != null && (prior || enforced.blind)) || (walled && !enforced2);
    const screened = blindScreen && families != null ? cfg.policy.switchModels : families;
    const family = enforced?.family ?? null;
    const switchFamilies = screened == null ? null : family != null && !screened.includes(family) ? [...screened, family] : screened;

    const seatExhausted = active != null && isExhausted(active, { now, thresholds: bars, currentId: id2, families: switchFamilies });
    if (!enforced2 && !isOver(active, obs2, { now, thresholds: bars, currentId: id2, families }) && !(enforced && seatExhausted)) {
      return depletedReplay(p, now) ?? { swapped: false, account: null, reason: "raced-already-swapped" };
    }

    const seatOf = (cur: { activeId: string | null; accounts: Account[] }): Account | null =>
      cur.accounts.find((a) => a.id === id2) ?? cur.accounts.find((a) => a.id === cur.activeId) ?? null;

    const present = p.presentIds();
    const rejected = new Set<string>();
    const usable = (accounts: Account[]): Account[] => accounts.filter((a) => !rejected.has(a.id) && (a.id === id2 || !present.has(a.id)));
    const skipOrThrow = (e: unknown, candidate: Account): void => {
      if (p.classifySwapError(e) === "fatal") throw e;
      rejected.add(candidate.id);
      log("decide.candidate_rejected", { account: candidate.id.slice(0, 8), error: e instanceof Error ? e.message : String(e) });
    };
    while (true) {
      const cur = loadAccounts(p.pool);
      const seat = seatOf(cur);
      const ctx: PickCtx = { now, thresholds: bars, currentId: seat?.id ?? null, families: switchFamilies };
      const best = pickBest(usable(cur.accounts), ctx);
      if (!best) break;
      try {
        await p.swap(best);
      } catch (e) {
        skipOrThrow(e, best);
        continue;
      }
      log("decide.swap", { account: best.id.slice(0, 8), enforced: enforced2 != null });
      return { swapped: true, account: best, reason: "swapped" };
    }

    if (!p.waitsWhenDepleted) {
      log("decide.depleted", { waitUntil: 0 });
      return { swapped: false, account: null, reason: "all-depleted" };
    }

    while (true) {
      const fresh = loadAccounts(p.pool);
      const current = seatOf(fresh);
      const ctx: PickCtx = { now, thresholds: bars, currentId: current?.id ?? null, families: switchFamilies };
      const currentAt = current ? usableAt(current, ctx) : Number.POSITIVE_INFINITY;
      const other = pickEarliestReset(usable(fresh.accounts), ctx);

      let target: Account | null = null;
      let waitUntil = Number.POSITIVE_INFINITY;
      if (other && other.availableAt < currentAt) { target = other.account; waitUntil = other.availableAt; }
      else if (current) { target = current; waitUntil = currentAt; }
      else if (other) { target = other.account; waitUntil = other.availableAt; }

      if (!target || waitUntil - now > cfg.policy.maxWaitMs) {
        log("decide.depleted", { waitUntil: Number.isFinite(waitUntil) ? waitUntil : 0 });
        return { swapped: false, account: null, reason: "all-depleted", ...(Number.isFinite(waitUntil) ? { waitUntil } : {}) };
      }

      const isCurrent = target.id === (current?.id ?? null);
      if (!isCurrent && !anticipatory) {
        log("decide.depleted_no_park", { account: target.id.slice(0, 8), waitUntil });
        return { swapped: false, account: null, reason: "all-depleted", waitUntil };
      }
      if (!isCurrent) {
        try {
          await p.swap(target);
        } catch (e) {
          skipOrThrow(e, target);
          continue;
        }
      }
      saveDepletedWait({ waitUntil, id: target.id, ts: now });
      log("decide.depleted_wait", { account: target.id.slice(0, 8), waitUntil });
      return { swapped: !isCurrent, account: target, reason: "depleted-wait", waitUntil };
    }
  });
}

function depletedReplay(p: Provider, now: number): SwapDecision | null {
  if (!p.waitsWhenDepleted) return null;
  const rec = loadDepletedWait();
  if (!rec || rec.waitUntil <= now) return null;
  const account = loadAccounts(p.pool).accounts.find((a) => a.id === rec.id) ?? null;
  if (!account) return null;
  if (account.id !== p.liveId()) return null;
  return { swapped: false, account, reason: "depleted-wait", waitUntil: rec.waitUntil };
}
