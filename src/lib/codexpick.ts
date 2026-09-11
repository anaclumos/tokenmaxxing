import { sortBy } from "es-toolkit";
import { nextWeeklyReset } from "./picker.ts";
import { isSessionWindow, weeklyWindowOf } from "./codexusage.ts";
import type { CodexAccount, CodexWindow, Thresholds } from "./types.ts";

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

export function isCodexExhausted(input: { account: CodexAccount; thresholds: Thresholds; now: number }): boolean {
  const { account, thresholds, now } = input;
  const sampledAt = account.lastUsageAt ?? null;
  return allWindows(account).some(
    (window) => liveUsed({ window, now, sampledAt }) >= barFor({ window, thresholds }),
  );
}

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

export const CODEX_SWAP_IMPROVEMENT = 1.2;

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

export function isCodexEngaged(input: { account: CodexAccount; floor: number; now: number }): boolean {
  const { account, floor, now } = input;
  const sampledAt = account.lastUsageAt ?? null;
  return allWindows(account).some((window) => liveUsed({ window, now, sampledAt }) >= floor);
}
