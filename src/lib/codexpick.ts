// Choose the codex account to switch TO. Same policy as the claude picker:
// among usable accounts (no reauth, no window at/over its screening bar that
// has not reset), take the one furthest behind its own weekly pace (highest
// pacePressure), because weekly allowance is forfeited at a fixed per-account
// reset. Windows are duration-classified (isSessionWindow), never assumed:
// codex's 5h window is absent on current Plus/Pro plans (July 2026), so the
// weekly aggregate may be the only bar there is.

import { sortBy } from "es-toolkit";
import { nextWeeklyReset } from "./picker.ts";
import { isSessionWindow, weeklyWindowOf } from "./codexusage.ts";
import type { CodexAccount, CodexWindow, Thresholds } from "./types.ts";

/** A window whose reset has passed reads as empty. A NULL reset self-bounds
 *  at sampledAt + the window's own duration (mirroring the claude picker's
 *  blockedUntil, closing-review catch): the wire schema allows reset_at null,
 *  and without the bound an over-bar null-reset window benched the account
 *  FOREVER on a headless box where nothing re-samples parked accounts - the
 *  no-permanent-bench invariant. No duration or sample time = trust the
 *  reading (unmeasured recovery must not look safe). */
function liveUsed(input: { window: CodexWindow; now: number; sampledAt: number | null }): number {
  const { window, now, sampledAt } = input;
  if (window.resetsAt != null) return window.resetsAt <= now ? 0 : window.usedPercentage;
  if (sampledAt != null && window.windowSeconds != null && now >= sampledAt + window.windowSeconds * 1000) return 0;
  return window.usedPercentage;
}

function allWindows(account: CodexAccount): CodexWindow[] {
  const usage = account.lastUsage;
  if (!usage) return [];
  return [...usage.aggregate, ...Object.values(usage.perLimit).flat()];
}

function barFor(input: { window: CodexWindow; thresholds: Thresholds }): number {
  return isSessionWindow({ window: input.window }) ? input.thresholds.session : input.thresholds.weekly;
}

/** A window at/over its bar whose reset has not passed blocks the account. */
export function isCodexExhausted(input: { account: CodexAccount; thresholds: Thresholds; now: number }): boolean {
  const { account, thresholds, now } = input;
  const sampledAt = account.lastUsageAt ?? null;
  return allWindows(account).some(
    (window) => liveUsed({ window, now, sampledAt }) >= barFor({ window, thresholds }),
  );
}

/** Forward pace pressure on the weekly aggregate: the burn rate the remaining
 *  weekly quota demands before its reset forfeits it. No sampled weekly window
 *  or no reset anchor ranks last (0): unmeasured must not look urgent. */
export function codexPacePressure(input: { account: CodexAccount; now: number }): number {
  const { account, now } = input;
  const weekly = account.lastUsage ? weeklyWindowOf({ aggregate: account.lastUsage.aggregate }) : null;
  if (!weekly) return 0;
  const reset = nextWeeklyReset(weekly.resetsAt, now);
  if (reset == null) return 0;
  return Math.max(0, 100 - liveUsed({ window: weekly, now, sampledAt: account.lastUsageAt ?? null })) / Math.max(1, reset - now);
}

function weeklyExpiryOf(input: { account: CodexAccount; now: number }): number {
  const { account, now } = input;
  const weekly = account.lastUsage ? weeklyWindowOf({ aggregate: account.lastUsage.aggregate }) : null;
  return nextWeeklyReset(weekly?.resetsAt ?? null, now) ?? Number.POSITIVE_INFINITY;
}

const codexSwapPreference = (now: number) => [
  (account: CodexAccount) => -codexPacePressure({ account, now }),
  (account: CodexAccount) => weeklyExpiryOf({ account, now }),
];

export function pickBestCodex(input: {
  accounts: CodexAccount[];
  thresholds: Thresholds;
  now: number;
  currentAccountId: string | null;
}): CodexAccount | null {
  const { accounts, thresholds, now, currentAccountId } = input;
  const usable = accounts.filter(
    (account) =>
      account.accountId !== currentAccountId &&
      account.needsReauth !== true &&
      !isCodexExhausted({ account, thresholds, now }),
  );
  return sortBy(usable, codexSwapPreference(now))[0] ?? null;
}

/** A codex greedy swap is a SIGTERM + respawn of a live session (codex cannot
 *  hot-adopt), and engagement is chronic on plans whose only window is weekly:
 *  without a margin, every hair of pace-pressure drift would visibly restart
 *  the user's session. The challenger must beat the incumbent by this factor
 *  (adversarial review catch, 2026-07-16); a crossed bar bypasses the margin
 *  entirely via the hard path. */
export const CODEX_SWAP_IMPROVEMENT = 1.2;

/** Greedy idempotence, mirroring picker.currentWins with the respawn-cost
 *  margin: the active account keeps its seat while usable unless a challenger
 *  beats its pace pressure by CODEX_SWAP_IMPROVEMENT. */
export function codexCurrentWins(input: {
  active: CodexAccount | null;
  accounts: CodexAccount[];
  thresholds: Thresholds;
  now: number;
}): boolean {
  const { active, accounts, thresholds, now } = input;
  if (!active || active.needsReauth === true || isCodexExhausted({ account: active, thresholds, now })) return false;
  const best = pickBestCodex({ accounts, thresholds, now, currentAccountId: null });
  if (best == null || best.accountId === active.accountId) return true;
  return codexPacePressure({ account: best, now }) <= codexPacePressure({ account: active, now }) * CODEX_SWAP_IMPROVEMENT;
}

/** True once any window is at/over the greedy engagement floor: with no 5h
 *  window on current codex plans, the floor reads against every window class
 *  rather than the session window alone. */
export function isCodexEngaged(input: { account: CodexAccount; floor: number; now: number }): boolean {
  const { account, floor, now } = input;
  const sampledAt = account.lastUsageAt ?? null;
  return allWindows(account).some((window) => liveUsed({ window, now, sampledAt }) >= floor);
}
