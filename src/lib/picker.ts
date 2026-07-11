// Choose the best account to switch TO when the active one crosses threshold.
// Policy: exclude the current account and any that need reauth or are still
// rate-limited (usage >= threshold and not yet past resets_at). Among the rest,
// prefer the account whose weekly window expires soonest: weekly limits reset
// at a fixed per-account time and unused allowance is forfeited at reset, so
// quota nearest its reset is use-it-or-lose-it and should be drained first.
// Tiebreak on lowest 7-day usage, then soonest 5h reset.

import { minBy, sortBy } from "es-toolkit";
import { z } from "zod";
import { AccountSchema, type Account } from "./types.ts";

const PickCtxSchema = z.object({
  now: z.number(),
  threshold: z.number(),
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

/** Epoch ms when the account's weekly quota is next forfeited. The weekly reset
 *  is a fixed per-account anchor, so a stale (past) resetsAt extrapolates
 *  forward in 7-day steps; an account with no sampled reset sorts last. */
export function weeklyExpiry(a: Account, now: number): number {
  const r = a.lastUsage?.sevenDay.resetsAt;
  if (r == null) return Number.POSITIVE_INFINITY;
  if (r > now) return r;
  return r + (Math.floor((now - r) / WEEK_MS) + 1) * WEEK_MS;
}

/** The switch preference: soonest weekly expiry first; tiebreak lowest 7-day
 *  usage, then soonest 5h reset. Shared with the statusLine pool ordering so
 *  the display order IS the swap order. */
export const swapPreference = (now: number) => [
  (a: Account) => weeklyExpiry(a, now),
  (a: Account) => a.lastUsage?.sevenDay.usedPercentage ?? 0,
  (a: Account) => a.lastUsage?.fiveHour.resetsAt ?? Number.POSITIVE_INFINITY,
];

export function pickBest(accounts: Account[], ctx: PickCtx): Account | null {
  const candidates = accounts.filter(
    (a) =>
      a.accountUuid !== ctx.currentAccountUuid &&
      !a.needsReauth &&
      !isExhausted(a, ctx),
  );
  if (candidates.length === 0) return null;
  return sortBy(candidates, swapPreference(ctx.now))[0]!;
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
