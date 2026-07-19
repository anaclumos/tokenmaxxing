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
import { AccountSchema, ThresholdsSchema, type Account, type Config, type Thresholds, type UsageWindow } from "./types.ts";

/** The effective per-window bars: configured thresholds minus the projection
 *  margin. ONE bar per window for BOTH the trigger and candidate screening -
 *  a screen laxer than the trigger would land swaps on accounts the trigger
 *  immediately re-flags (cooldown-throttled ping-pong). Every PickCtx and the
 *  trigger floors must be built from this. */
export function effectiveBars(cfg: Config): Thresholds {
  return {
    session: cfg.thresholds.session - cfg.policy.projectionMargin,
    weekly: cfg.thresholds.weekly - cfg.policy.projectionMargin,
  };
}

const PickCtxSchema = z.object({
  now: z.number(),
  thresholds: ThresholdsSchema,
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
function blockedUntil(w: UsageWindow, windowMs: number, sampledAt: number | undefined, threshold: number): number {
  if (w.usedPercentage < threshold) return 0;
  if (w.resetsAt != null) return w.resetsAt;
  return sampledAt != null ? sampledAt + windowMs : Number.POSITIVE_INFINITY;
}

/** When each of the account's windows stops blocking: the two aggregates plus
 *  the gated per-model caps, each against its own threshold (session swaps
 *  earlier than the weekly windows, and a candidate is screened by the same
 *  bar that would trigger a switch off it - landing below the trigger bar
 *  would ping-pong). */
function blockingUntil(a: Account, ctx: PickCtx): number[] {
  const u = a.lastUsage;
  return [
    ...(u
      ? [
          blockedUntil(u.fiveHour, FIVE_HOURS_MS, a.lastUsageAt, ctx.thresholds.session),
          blockedUntil(u.sevenDay, WEEK_MS, a.lastUsageAt, ctx.thresholds.weekly),
        ]
      : []),
    // per-model rows date by their OWN sample time when known: lastUsageAt
    // advances on every engaged evaluation while the rows may be days older,
    // which inflated the null-reset self-bound (closing-review catch).
    ...gatedPerModelWindows(a, ctx.switchFamilies).map((w) => blockedUntil(w, WEEK_MS, a.lastPerModelAt ?? a.lastUsageAt, ctx.thresholds.weekly)),
  ];
}

/** An account is "exhausted" if a window is >= its threshold and hasn't reset yet. */
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

/** Soonest upcoming reset among the account's cached windows: the 5h session
 *  reset if still ahead, else the extrapolated weekly expiry; Infinity with no
 *  known reset anchor (sorts last). Display order for `status` and the
 *  statusLine pool (user decision 2026-07-18) - deliberately decoupled from
 *  swapPreference, which keeps ranking actual swaps. */
export function earliestReset(a: Account, now: number): number {
  const fiveHour = a.lastUsage?.fiveHour.resetsAt;
  return Math.min(fiveHour != null && fiveHour > now ? fiveHour : Number.POSITIVE_INFINITY, weeklyExpiry(a, now));
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
 *  Ranks swaps only; display surfaces order by earliestReset instead. */
const swapPreference = (now: number) => [
  (a: Account) => -pacePressure(a, now),
  (a: Account) => weeklyExpiry(a, now),
  // unmeasured ranks LAST in this tiebreak (101 > any real percentage):
  // `?? 0` made a never-sampled account look maximally safe and beat any
  // measured one, swapping a healthy measured seat onto a complete unknown -
  // the exact unmeasured-must-not-look-safe rule (closing-review catch);
  // pacePressure already ranks unmeasured last by the same principle.
  (a: Account) => a.lastUsage?.sevenDay.usedPercentage ?? 101,
];

export function pickBest(accounts: Account[], ctx: PickCtx): Account | null {
  const usable = accounts.filter(
    (a) => a.accountUuid !== ctx.currentAccountUuid && !a.needsReauth && !isExhausted(a, ctx),
  );
  return sortBy(usable, swapPreference(ctx.now))[0] ?? null;
}

/** Greedy idempotence, shared by bare `xx switch` and the hooks/timer path:
 *  the active account keeps its seat while it is usable and no other usable
 *  account ranks STRICTLY better on swapPreference - swapping between equals
 *  buys nothing and would ping-pong. Rank with currentAccountUuid null so the
 *  active account competes. */
export function currentWins(active: Account | null, accounts: Account[], ctx: PickCtx): boolean {
  if (!active || active.needsReauth || isExhausted(active, ctx)) return false;
  const best = pickBest(accounts, { ...ctx, currentAccountUuid: null });
  if (best == null || best.accountUuid === active.accountUuid) return true;
  return swapPreference(ctx.now).every((k) => k(active) === k(best));
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
