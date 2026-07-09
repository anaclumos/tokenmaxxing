// Choose the best account to switch TO when the active one crosses threshold.
// Policy: exclude the current account and any that need reauth or are still
// rate-limited (usage >= threshold and not yet past resets_at). Among the rest,
// prefer lowest 7-day usage; tiebreak on soonest resets_at.

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

export function pickBest(accounts: Account[], ctx: PickCtx): Account | null {
  const candidates = accounts.filter(
    (a) =>
      a.accountUuid !== ctx.currentAccountUuid &&
      !a.needsReauth &&
      !isExhausted(a, ctx),
  );
  if (candidates.length === 0) return null;

  // lowest 7-day usage first; tiebreak on soonest 5h reset.
  return sortBy(candidates, [
    (a) => a.lastUsage?.sevenDay.usedPercentage ?? 0,
    (a) => a.lastUsage?.fiveHour.resetsAt ?? Number.POSITIVE_INFINITY,
  ])[0]!;
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
