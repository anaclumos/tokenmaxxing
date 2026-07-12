// Choose the account to switch TO. Greedy policy: among usable accounts (no
// reauth, no window >= threshold that hasn't reset yet), take the one whose
// weekly window expires soonest - weekly limits reset at a fixed per-account
// time and unused allowance is forfeited at reset, so quota nearest its reset
// is use-it-or-lose-it and should be drained first. Runs entirely off each
// account's cached windows (absolute UTC epochs, so a stale snapshot still
// resolves to the correct upcoming reset), which makes the pick deterministic
// and idempotent: re-running lands on the same account.

import { minBy, sortBy } from "es-toolkit";
import { z } from "zod";
import { AccountSchema, type Account } from "./types.ts";

const PickCtxSchema = z.object({
  now: z.number(),
  threshold: z.number(),
  /** account to exclude (hooks switch AWAY from it); null ranks everyone. */
  currentAccountUuid: z.string().nullable(),
});
export type PickCtx = z.infer<typeof PickCtxSchema>;

/** An account is "exhausted" if a window is >= threshold and hasn't reset yet. */
export function isExhausted(a: Account, ctx: PickCtx): boolean {
  const u = a.lastUsage;
  if (!u) return false;
  const blocked = (w: { usedPercentage: number; resetsAt: number | null }) =>
    w.usedPercentage >= ctx.threshold && (w.resetsAt == null || w.resetsAt > ctx.now);
  return blocked(u.fiveHour) || blocked(u.sevenDay);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

/** The switch preference: soonest weekly expiry first, tiebreak lowest 7-day
 *  usage. Shared with the statusLine pool ordering so the display order IS the
 *  swap order. */
export const swapPreference = (now: number) => [
  (a: Account) => weeklyExpiry(a, now),
  (a: Account) => a.lastUsage?.sevenDay.usedPercentage ?? 0,
];

export function pickBest(accounts: Account[], ctx: PickCtx): Account | null {
  const usable = accounts.filter(
    (a) => a.accountUuid !== ctx.currentAccountUuid && !a.needsReauth && !isExhausted(a, ctx),
  );
  return sortBy(usable, swapPreference(ctx.now))[0] ?? null;
}

/** When an account becomes usable again: the latest reset among its over-threshold
 *  windows (all must reset), or `now` if nothing is over. */
export function usableAt(a: Account, threshold: number, now: number): number {
  const u = a.lastUsage;
  if (!u) return now;
  const blocking = [u.fiveHour, u.sevenDay]
    .filter((w) => w.usedPercentage >= threshold && w.resetsAt != null)
    .map((w) => w.resetsAt as number);
  return blocking.length ? Math.max(...blocking) : now;
}

const EarliestResetSchema = z.object({ account: AccountSchema, availableAt: z.number() });
export type EarliestReset = z.infer<typeof EarliestResetSchema>;

/** For the all-depleted case: the account (not current, not reauth) that becomes
 *  usable soonest. */
export function pickEarliestReset(accounts: Account[], ctx: PickCtx): EarliestReset | null {
  const mapped = accounts
    .filter((a) => a.accountUuid !== ctx.currentAccountUuid && !a.needsReauth)
    .map((a) => ({ account: a, availableAt: usableAt(a, ctx.threshold, ctx.now) }));
  return minBy(mapped, (x) => x.availableAt) ?? null;
}
