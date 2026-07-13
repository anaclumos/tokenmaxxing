// Choose the account to switch TO. Greedy policy: among usable accounts (no
// reauth, no window >= threshold that hasn't reset yet), take the one furthest
// behind its own weekly pace - highest pacePressure, the burn rate its
// remaining weekly quota demands to be consumed at before the fixed
// per-account reset forfeits it (weekly allowance is use-it-or-lose-it).
// This refines the older soonest-expiry policy in both directions: equal
// remaining reduces to soonest expiry first, equal expiry to most remaining
// first. Runs entirely off each account's cached windows (absolute UTC
// epochs, so a stale snapshot still resolves to the correct upcoming reset),
// which makes the pick deterministic and idempotent: re-running lands on the
// same account.

import { minBy, sortBy } from "es-toolkit";
import { z } from "zod";
import { familyTokens } from "./usage.ts";
import { AccountSchema, type Account, type UsageWindow } from "./types.ts";

const PickCtxSchema = z.object({
  now: z.number(),
  threshold: z.number(),
  /** account to exclude (hooks switch AWAY from it); null ranks everyone. */
  currentAccountUuid: z.string().nullable(),
  /** families whose per-model weekly cap counts toward exhaustion (from
   *  gatedFamilies): a candidate with a burnt gated cap is no switch target -
   *  landing on it would re-trigger the same gate and ping-pong the pool. */
  switchFamilies: z.array(z.string()),
});
export type PickCtx = z.infer<typeof PickCtxSchema>;

/** The account's cached per-model windows that belong to a gated family. */
function gatedPerModelWindows(a: Account, families: string[]): UsageWindow[] {
  return Object.entries(a.lastPerModel ?? {})
    .filter(([model]) => families.some((f) => familyTokens(model).includes(f)))
    .map(([, w]) => w);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** Epoch until which `w` blocks the account; anything <= now means it does not
 *  block. A window with no known reset (unparsed clock) is still bounded by
 *  its own duration past the sample time - a 5h window sampled 6h ago has
 *  certainly reset - so a benched account always recovers by itself. With no
 *  sample time either, it blocks indefinitely: guessing "usable now" would
 *  swap onto it with waitUntil=now and churn kill/respawn. */
function blockedUntil(w: UsageWindow, windowMs: number, sampledAt: number | undefined, ctx: PickCtx): number {
  if (w.usedPercentage < ctx.threshold) return 0;
  if (w.resetsAt != null) return w.resetsAt;
  return sampledAt != null ? sampledAt + windowMs : Number.POSITIVE_INFINITY;
}

/** When each of the account's windows stops blocking: the two aggregates plus
 *  the gated per-model caps. */
function blockingUntil(a: Account, ctx: PickCtx): number[] {
  const u = a.lastUsage;
  return [
    ...(u ? [blockedUntil(u.fiveHour, FIVE_HOURS_MS, a.lastUsageAt, ctx), blockedUntil(u.sevenDay, WEEK_MS, a.lastUsageAt, ctx)] : []),
    ...gatedPerModelWindows(a, ctx.switchFamilies).map((w) => blockedUntil(w, WEEK_MS, a.lastUsageAt, ctx)),
  ];
}

/** An account is "exhausted" if a window is >= threshold and hasn't reset yet. */
export function isExhausted(a: Account, ctx: PickCtx): boolean {
  return blockingUntil(a, ctx).some((t) => t > ctx.now);
}

/** Next occurrence of a weekly reset. The weekly reset is a fixed per-account
 *  anchor, so a cached (past) resetsAt extrapolates forward in 7-day steps -
 *  an old snapshot still yields the correct upcoming reset. */
export function nextWeeklyReset(resetsAt: number | null, now: number): number | null {
  if (resetsAt == null || resetsAt > now) return resetsAt;
  return resetsAt + (Math.floor((now - resetsAt) / WEEK_MS) + 1) * WEEK_MS;
}

/** Epoch ms when the account's weekly quota is next forfeited; an account with
 *  no sampled reset sorts last. */
export function weeklyExpiry(a: Account, now: number): number {
  return nextWeeklyReset(a.lastUsage?.sevenDay.resetsAt ?? null, now) ?? Number.POSITIVE_INFINITY;
}

/** How far behind its own weekly pace the account is, measured forward: the
 *  burn rate (percent per ms) its remaining weekly quota must be consumed at
 *  to beat the reset that forfeits it. A backward-looking used/expected ratio
 *  blows up right after a reset (expected ~0) and ignores how much quota is
 *  at risk; the required forward rate has neither problem. A window past its
 *  cached reset counts as empty (the account is fresh again); an account with
 *  no sampled reset anchor has nothing to forfeit on any known clock and
 *  ranks last (0). */
export function pacePressure(a: Account, now: number): number {
  const cached = a.lastUsage?.sevenDay;
  const reset = nextWeeklyReset(cached?.resetsAt ?? null, now);
  if (cached == null || reset == null) return 0;
  const used = cached.resetsAt != null && cached.resetsAt <= now ? 0 : cached.usedPercentage;
  return Math.max(0, 100 - used) / Math.max(1, reset - now);
}

/** The switch preference: furthest behind its own weekly pace first (highest
 *  pacePressure), tiebreak soonest weekly expiry then lowest 7-day usage.
 *  Shared with the statusLine pool ordering so the display order IS the
 *  swap order. */
export const swapPreference = (now: number) => [
  (a: Account) => -pacePressure(a, now),
  (a: Account) => weeklyExpiry(a, now),
  (a: Account) => a.lastUsage?.sevenDay.usedPercentage ?? 0,
];

export function pickBest(accounts: Account[], ctx: PickCtx): Account | null {
  const usable = accounts.filter(
    (a) => a.accountUuid !== ctx.currentAccountUuid && !a.needsReauth && !isExhausted(a, ctx),
  );
  return sortBy(usable, swapPreference(ctx.now))[0] ?? null;
}

/** When an account becomes usable again: the latest blocking bound among its
 *  windows (all must clear), or `now` if nothing blocks. Consistent with
 *  isExhausted by construction (same blockingUntil). */
export function usableAt(a: Account, ctx: PickCtx): number {
  const blocking = blockingUntil(a, ctx).filter((t) => t > ctx.now);
  return blocking.length ? Math.max(...blocking) : ctx.now;
}

const EarliestResetSchema = z.object({ account: AccountSchema, availableAt: z.number() });
export type EarliestReset = z.infer<typeof EarliestResetSchema>;

/** For the all-depleted case: the account (not current, not reauth) that becomes
 *  usable soonest. Accounts blocked with no known reset are unknowable, never
 *  a wait target. */
export function pickEarliestReset(accounts: Account[], ctx: PickCtx): EarliestReset | null {
  const mapped = accounts
    .filter((a) => a.accountUuid !== ctx.currentAccountUuid && !a.needsReauth)
    .map((a) => ({ account: a, availableAt: usableAt(a, ctx) }))
    .filter((x) => Number.isFinite(x.availableAt));
  return minBy(mapped, (x) => x.availableAt) ?? null;
}
