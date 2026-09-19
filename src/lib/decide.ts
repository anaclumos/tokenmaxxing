import { withLock } from "./lock.ts";
import { loadAccounts, loadConfig, saveAccounts } from "./state.ts";
import { isExhausted, limitWindows, nextWeeklyReset, pickBest, pickEarliestReset, sessionWindow, thresholdBars, usableAt, weeklyWindow, type PickCtx } from "./picker.ts";
import { familyTokens } from "./usage.ts";
import { errorMessage, log } from "./log.ts";
import type { Observation, Provider } from "./provider.ts";
import type { Account, EnforcedLimit } from "./types.ts";

export type SwapDecision = { swapped: boolean; account: Account | null; reason: string; waitUntil?: number };

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

export async function evaluateAndMaybeSwap(p: Provider, now = Date.now(), canRespawn = false, enforced: EnforcedLimit | null = null, seatId: string | null = p.liveId()): Promise<SwapDecision> {
  const activeId = seatId;
  const cfg = loadConfig();
  const bars = thresholdBars(cfg);
  const stored0 = loadAccounts(p.pool).accounts.find((a) => a.id === activeId);
  const walled0 = stored0?.enforcedUntil != null && stored0.enforcedUntil > now;
  const observed = stored0 ? await p.observeLive(stored0, cfg, now, { probe: enforced == null && !walled0 }) : null;
  const stored = loadAccounts(p.pool).accounts.find((a) => a.id === activeId);

  if (!enforced && !isOver(stored, observed, { now, thresholds: bars, currentId: activeId, families: p.gatedFamilies(cfg), seats: null })) {
    return { swapped: false, account: null, reason: "under-threshold-or-stale" };
  }

  return withLock(p.pool.lockFile, async () => {
    const idx = loadAccounts(p.pool);
    const id2 = seatId;
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

    let obs2: Observation | null = null;
    for (const a of idx.accounts) {
      const obs = await p.observeLive(a, cfg, now, { probe: false });
      if (a === active) obs2 = obs;
      if (obs && (a.lastUsageAt == null || obs.at > a.lastUsageAt)) {
        a.windows = p.mergeWindows(obs.windows, a.windows);
        a.lastUsageAt = obs.at;
      }
    }
    saveAccounts(p.pool, idx);

    const families = p.gatedFamilies(cfg);
    const walled = active?.enforcedUntil != null && active.enforcedUntil > now;
    const blindScreen = (enforced != null && (prior || enforced.blind)) || (walled && !enforced2);
    const screened = blindScreen && families != null ? cfg.policy.switchModels : families;
    const family = enforced?.family ?? null;
    const switchFamilies = screened == null ? null : family != null && !screened.includes(family) ? [...screened, family] : screened;
    const present = p.presence();
    const seats = p.seats === "shared" ? present : null;

    const seatExhausted = active != null && isExhausted(active, { now, thresholds: bars, currentId: id2, families: switchFamilies, seats });
    if (!enforced2 && !isOver(active, obs2, { now, thresholds: bars, currentId: id2, families, seats }) && !(enforced && seatExhausted)) {
      return { swapped: false, account: null, reason: "raced-already-swapped" };
    }
    if (p.seats === "shared" && !canRespawn) {
      return { swapped: false, account: null, reason: "needs-respawn" };
    }

    const seatOf = (cur: { accounts: Account[] }): Account | null => cur.accounts.find((a) => a.id === id2) ?? null;

    const rejected = new Set<string>();
    const usable = (accounts: Account[]): Account[] => accounts.filter((a) => !rejected.has(a.id) && (p.seats === "shared" || a.id === id2 || !present.has(a.id)));
    const skipOrThrow = (e: unknown, candidate: Account): void => {
      if (p.classifySwapError(e) === "fatal") throw e;
      rejected.add(candidate.id);
      log("decide.candidate_rejected", { account: candidate.id.slice(0, 8), error: errorMessage(e) });
    };
    while (true) {
      const cur = loadAccounts(p.pool);
      const seat = seatOf(cur);
      const ctx: PickCtx = { now, thresholds: bars, currentId: seat?.id ?? null, families: switchFamilies, seats };
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
      const ctx: PickCtx = { now, thresholds: bars, currentId: current?.id ?? null, families: switchFamilies, seats };
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
      if (!isCurrent) {
        try {
          await p.swap(target);
        } catch (e) {
          skipOrThrow(e, target);
          continue;
        }
      }
      log("decide.depleted_wait", { account: target.id.slice(0, 8), waitUntil });
      return { swapped: !isCurrent, account: target, reason: "depleted-wait", waitUntil };
    }
  });
}
