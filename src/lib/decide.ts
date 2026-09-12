import { z } from "zod";
import { withLock } from "./lock.ts";
import { claudePool } from "./paths.ts";
import { POST_SWAP_COOLDOWN_MS, loadAccounts, loadConfig, loadDepletedWait, loadLastSwapAt, saveAccounts, saveDepletedWait } from "./state.ts";
import { readOAuthAccount } from "./claudejson.ts";
import { isExhausted, limitWindows, nextWeeklyReset, pickBest, pickEarliestReset, sessionWindow, thresholdBars, usableAt, weeklyWindow, type PickCtx } from "./picker.ts";
import { familyTokens, type EnforcedClass } from "./usage.ts";
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

export async function evaluateAndMaybeSwap(p: Provider, now = Date.now(), anticipatory = false, enforced: EnforcedLimit | null = null): Promise<SwapDecision> {
  const activeId = p.liveId();
  const enforced0 = enforced && enforced.account === activeId ? enforced : null;

  const lastSwapAt = loadLastSwapAt(p.pool);
  if (lastSwapAt != null && now - lastSwapAt < POST_SWAP_COOLDOWN_MS) {
    return depletedReplay(p, now) ?? { swapped: false, account: null, reason: "post-swap-cooldown" };
  }

  const cfg = loadConfig();
  const bars = thresholdBars(cfg);
  const stored0 = loadAccounts(p.pool).accounts.find((a) => a.id === activeId);
  const observed = stored0 ? await p.observeLive(stored0, cfg, now, { probe: true }) : null;
  const stored = loadAccounts(p.pool).accounts.find((a) => a.id === activeId);

  if (!enforced0 && !isOver(stored, observed, { now, thresholds: bars, currentId: activeId, families: p.gatedFamilies(cfg) })) {
    if (!observed) {
      const replay = depletedReplay(p, now);
      if (replay) return replay;
    }
    return { swapped: false, account: null, reason: "under-threshold-or-stale" };
  }

  return withLock(p.pool.lockFile, async () => {
    const lastSwapAt2 = loadLastSwapAt(p.pool);
    if (lastSwapAt2 != null && now - lastSwapAt2 < POST_SWAP_COOLDOWN_MS) {
      return { swapped: false, account: null, reason: "raced-already-swapped" };
    }
    const idx = loadAccounts(p.pool);
    const id2 = p.liveId();
    const enforced2 = enforced0 && enforced0.account === id2 ? enforced0 : null;
    const active = id2 ? idx.accounts.find((a) => a.id === id2) : undefined;

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
    const blind = !enforced2 || enforced2.blind;
    const screened = walled && blind ? cfg.policy.switchModels : families;
    const switchFamilies =
      screened == null ? null : enforced2?.family && !screened.includes(enforced2.family) ? [...screened, enforced2.family] : screened;

    if (!enforced2 && !isOver(active, obs2, { now, thresholds: bars, currentId: id2, families })) {
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
      const enforcedUntil = enforced2 && current && current.id === enforced2.account ? (enforced2.resetsAt ?? now + enforced2.windowMs) : 0;
      const currentAt = current ? Math.max(usableAt(current, ctx), enforcedUntil) : Number.POSITIVE_INFINITY;
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

export function enforcedWindowMs(limit: EnforcedClass): number {
  return limit.kind === "session" ? FIVE_HOURS_MS : WEEK_MS;
}

const StampSchema = z.object({ outcome: z.enum(["stamped", "account-moved", "not-pooled"]), resetsAt: z.number(), sole: z.boolean() });
export type Stamp = z.infer<typeof StampSchema>;

export async function recordEnforcedLimit(input: { limit: EnforcedClass; account: string; now: number }): Promise<Stamp> {
  const { limit, account: id, now } = input;
  return withLock(claudePool.lockFile, () => {
    const fallback = now + enforcedWindowMs(limit);
    if ((readOAuthAccount()?.accountUuid ?? null) !== id) return { outcome: "account-moved", resetsAt: limit.resetsAt ?? fallback, sole: false };
    const idx = loadAccounts(claudePool);
    const account = idx.accounts.find((a) => a.id === id);
    if (!account) return { outcome: "not-pooled", resetsAt: limit.resetsAt ?? fallback, sole: false };
    const familyReset =
      limit.kind === "model"
        ? limitWindows(account)
            .filter((w) => familyTokens(w.name ?? "").includes(limit.family))
            .map((w) => w.resetsAt)
            .find((r): r is number => r != null) ?? null
        : null;
    const session = sessionWindow(account)?.resetsAt ?? null;
    const cachedReset =
      limit.kind === "session"
        ? session != null && session > now ? session : null
        : nextWeeklyReset(familyReset ?? weeklyWindow(account)?.resetsAt ?? null, now);
    const next = limit.resetsAt ?? cachedReset ?? fallback;
    const sole = account.enforcedUntil == null || account.enforcedUntil <= now;
    const resetsAt = Math.max(account.enforcedUntil ?? 0, next);
    account.enforcedUntil = resetsAt;
    account.lastProbeAt = now;
    saveAccounts(claudePool, idx);
    log("usage.enforced_limit", { kind: limit.kind, family: limit.kind === "model" ? limit.family : undefined, resetsAt, sole });
    return { outcome: "stamped", resetsAt, sole };
  });
}
