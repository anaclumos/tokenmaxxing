import { maxBy, minBy, sortBy } from "es-toolkit";
import { familyTokens } from "./usage.ts";
import type { Account, BankedReset, Bars, Config, Thresholds, Window } from "./types.ts";

export function thresholdBars(cfg: Config): Bars {
  const bars = (t: Thresholds): Thresholds => ({ session: t.session - cfg.policy.projectionMargin, weekly: t.weekly });
  return {
    ...bars(cfg.thresholds),
    accounts: new Map(Object.entries(cfg.thresholds.accounts).map(([label, t]) => [label, { ...bars(t), credits: t.credits }])),
    accountReleaseMs: cfg.policy.accountReleaseMs,
  };
}

export type PickCtx = {
  now: number;
  thresholds: Bars;
  currentId: string | null;
  families: string[] | null;
  held?: string[] | null;
  seats: Map<string, number> | null;
  planWeight?: (a: Account) => number;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_WINDOW_MAX_S = 6 * 3600;

export function isSessionWindow(w: Window): boolean {
  return w.windowSeconds != null && w.windowSeconds <= SESSION_WINDOW_MAX_S;
}

export function sessionWindow(a: Account): Window | undefined {
  return a.windows.find((w) => w.name == null && isSessionWindow(w));
}

export function weeklyWindow(a: Account): Window | undefined {
  return maxBy(a.windows.filter((w) => w.name == null && !isSessionWindow(w)), (w) => w.windowSeconds ?? 0);
}

type NamedWindow = Window & { name: string };

export function limitWindows(a: Account): NamedWindow[] {
  return a.windows.filter((w): w is NamedWindow => w.name != null);
}

export function gatedWindows(a: Account, families: string[] | null): NamedWindow[] {
  const named = limitWindows(a);
  return families == null ? named : named.filter((w) => families.some((f) => familyTokens(w.name).includes(f)));
}

export function liveUsed(w: Window, now: number): number {
  if (w.resetsAt != null) return w.resetsAt <= now ? 0 : w.usedPercentage;
  if (w.windowSeconds != null && now >= w.sampledAt + w.windowSeconds * 1000) return 0;
  return w.usedPercentage;
}

function releaseMs(w: Window, bars: Bars): number {
  return isSessionWindow(w) ? bars.accountReleaseMs.session : bars.accountReleaseMs.weekly;
}

export function barFor(a: Account, w: Window, bars: Bars, now: number): number {
  const pick = (t: Thresholds) => (isSessionWindow(w) ? t.session : t.weekly);
  const own = bars.accounts.get(a.label);
  if (own == null) return pick(bars);
  const reset = windowResetAt(w, now);
  const released = reset != null && reset > now && reset - now <= releaseMs(w, bars);
  return released ? Math.max(pick(own), pick(bars)) : pick(own);
}

export function bufferedUsed(a: Account, w: Window, bars: Bars, now: number): number {
  const used = liveUsed(w, now);
  const bar = barFor(a, w, bars, now);
  if (bar <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, (used / bar) * 100);
}

function windowEnd(w: Window): number {
  return w.resetsAt ?? w.sampledAt + (w.windowSeconds ?? 0) * 1000;
}

function spendsCredits(a: Account, bars: Bars): boolean {
  return bars.accounts.get(a.label)?.credits === true && a.hasCredits !== false;
}

function blockedUntil(a: Account, w: Window, bars: Bars, now: number): number {
  const used = liveUsed(w, now);
  if (used < barFor(a, w, bars, now) || spendsCredits(a, bars)) return 0;
  const reset = windowEnd(w);
  const release = reset - releaseMs(w, bars);
  return release > now && used < barFor(a, w, bars, release) ? release : reset;
}

export function screensUntilReset(a: Account, w: Window, bars: Bars, now: number): boolean {
  const reset = windowEnd(w);
  return reset > now && blockedUntil(a, w, bars, now) === reset;
}

// A family wall binds only a session whose model is in that family; an unknown model (`held` null or absent) is bound by every one.
export function wallUntil(a: Account, held: string[] | null | undefined): number {
  const family = Object.entries(a.familyUntil ?? {}).filter(([f]) => held == null || held.includes(f));
  return Math.max(a.enforcedUntil ?? 0, ...family.map(([, t]) => t));
}

export function liveFamilyWalls(a: Account, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(a.familyUntil ?? {}).filter(([, t]) => t > now));
}

function blockingUntil(a: Account, ctx: PickCtx): number[] {
  return [
    ...a.windows.filter((w) => w.name == null).map((w) => blockedUntil(a, w, ctx.thresholds, ctx.now)),
    ...gatedWindows(a, ctx.families).map((w) => blockedUntil(a, w, ctx.thresholds, ctx.now)),
    wallUntil(a, ctx.held),
  ];
}

export function isExhausted(a: Account, ctx: PickCtx): boolean {
  return blockingUntil(a, ctx).some((t) => t > ctx.now);
}

export function landWindows(a: Account, windows: Window[], at: number, thresholds: Bars): void {
  const ctx: PickCtx = { now: at, thresholds, currentId: null, families: [], held: [], seats: null };
  const bare = (): Account => ({ ...a, enforcedUntil: undefined, familyUntil: undefined, hasCredits: false });
  const familyBlocked = (f: string): boolean => gatedWindows(a, [f]).some((w) => blockedUntil(bare(), w, thresholds, at) > at);
  const blocked = a.enforcedUntil != null && isExhausted(bare(), ctx);
  const families = Object.keys(a.familyUntil ?? {}).filter(familyBlocked);
  a.windows = windows;
  a.lastUsageAt = at;
  if (blocked && !isExhausted(bare(), ctx)) a.enforcedUntil = undefined;
  const cleared = families.filter((f) => !familyBlocked(f));
  if (cleared.length > 0) a.familyUntil = Object.fromEntries(Object.entries(a.familyUntil ?? {}).filter(([f]) => !cleared.includes(f)));
}

export function nextWeeklyReset(resetsAt: number | null, now: number): number | null {
  if (resetsAt == null || resetsAt > now) return resetsAt;
  return resetsAt + (Math.floor((now - resetsAt) / WEEK_MS) + 1) * WEEK_MS;
}

export function weeklyExpiry(a: Account, now: number): number {
  return nextWeeklyReset(weeklyWindow(a)?.resetsAt ?? null, now) ?? Number.POSITIVE_INFINITY;
}

const BANKED_RESET_LEAD_MS = 3 * 24 * 60 * 60 * 1000;

export function wantsBankedReset(a: Account, bars: Bars, now: number): boolean {
  const weekly = weeklyWindow(a);
  const left = weeklyExpiry(a, now) - now;
  return a.bankedReset != null && weekly != null && liveUsed(weekly, now) >= barFor(a, weekly, bars, now) && Number.isFinite(left) && left > BANKED_RESET_LEAD_MS;
}

export function landGrant(a: Account, grant: BankedReset | undefined, sentAt: number): void {
  if (sentAt <= (a.bankedResetAt ?? 0)) return;
  a.bankedReset = grant;
  a.bankedResetAt = sentAt;
}

export function earliestReset(a: Account, now: number): number {
  const session = sessionWindow(a)?.resetsAt;
  return Math.min(session != null && session > now ? session : Number.POSITIVE_INFINITY, weeklyExpiry(a, now));
}

function windowResetAt(w: Window, now: number): number | null {
  if (w.resetsAt != null) return nextWeeklyReset(w.resetsAt, now);
  if (w.windowSeconds != null) return w.sampledAt + w.windowSeconds * 1000;
  return null;
}

export function pacePressure(a: Account, ctx: PickCtx): number {
  const binding = minBy(gatedWindows(a, ctx.families), (w) => Math.max(0, 100 - liveUsed(w, ctx.now)));
  if (binding != null) {
    const reset = windowResetAt(binding, ctx.now);
    if (reset != null) return Math.max(0, 100 - liveUsed(binding, ctx.now)) / Math.max(1, reset - ctx.now);
  }
  const weekly = weeklyWindow(a);
  const reset = nextWeeklyReset(weekly?.resetsAt ?? null, ctx.now);
  if (weekly == null || reset == null) return 0;
  return Math.max(0, 100 - liveUsed(weekly, ctx.now)) / Math.max(1, reset - ctx.now);
}

export function seatHeadroom(a: Account, ctx: PickCtx): number {
  const session = sessionWindow(a);
  if (session == null) return Number.NEGATIVE_INFINITY;
  return (barFor(a, session, ctx.thresholds, ctx.now) - liveUsed(session, ctx.now)) / ((ctx.seats?.get(a.id) ?? 0) + 1);
}

const MIN_SEAT_HEADROOM = 5;

const planWeight = (a: Account, ctx: PickCtx): number => ctx.planWeight?.(a) ?? 1;

function seatFull(a: Account, ctx: PickCtx): boolean {
  const session = sessionWindow(a);
  if (ctx.seats == null || session == null || spendsCredits(a, ctx.thresholds)) return false;
  return seatHeadroom(a, ctx) * planWeight(a, ctx) < MIN_SEAT_HEADROOM;
}

export function onCredits(a: Account, ctx: PickCtx): boolean {
  return spendsCredits(a, ctx.thresholds) && isExhausted({ ...a, hasCredits: false }, ctx);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKLY_SOON_MS = 4 * DAY_MS;
const THREAD_HEADROOM = 15;
const SESSION_SOON_MS = 60 * 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;

function cramped(a: Account, ctx: PickCtx): boolean {
  const session = sessionWindow(a);
  if (session == null || spendsCredits(a, ctx.thresholds)) return false;
  const end = windowEnd(session);
  const resetsSoon = end > ctx.now && end - ctx.now <= SESSION_SOON_MS;
  return !resetsSoon && seatHeadroom(a, ctx) * planWeight(a, ctx) < THREAD_HEADROOM;
}

// Judged per window, because a fresh statusline sample refreshes the session and weekly figures but carries an old per-model cap forward.
function stale(a: Account, ctx: PickCtx): boolean {
  const read = [sessionWindow(a), weeklyWindow(a), ...gatedWindows(a, ctx.families)];
  return read.some((w) => w != null && windowEnd(w) > ctx.now && ctx.now - w.sampledAt > STALE_MS);
}

const swapPreference = (ctx: PickCtx) => [
  (a: Account) => (onCredits(a, ctx) ? 1 : 0),
  (a: Account) => ((a.storeFails ?? 0) > 0 ? 1 : 0),
  (a: Account) => (a.windows.length === 0 ? 1 : 0),
  // A full account ranks after every open one, and among full accounts the most room per session wins.
  (a: Account) => (seatFull(a, ctx) ? 1 : 0),
  (a: Account) => (seatFull(a, ctx) ? -seatHeadroom(a, ctx) * planWeight(a, ctx) : 0),
  // An account with a session window first: its 5-hour quota comes back within hours, while an account with only a weekly window spends quota that is gone until the week resets.
  (a: Account) => (sessionWindow(a) == null ? 1 : 0),
  (a: Account) => (cramped(a, ctx) ? 1 : 0),
  (a: Account) => (weeklyExpiry(a, ctx.now) - ctx.now <= WEEKLY_SOON_MS ? 0 : 1),
  (a: Account) => (stale(a, ctx) ? 1 : 0),
  ...(ctx.seats == null ? [] : [(a: Account) => -seatHeadroom(a, ctx) * planWeight(a, ctx)]),
  (a: Account) => -pacePressure(a, ctx) * planWeight(a, ctx),
  (a: Account) => weeklyExpiry(a, ctx.now),
  (a: Account) => weeklyWindow(a)?.usedPercentage ?? 101,
  ...(ctx.seats == null ? [] : [(a: Account) => ctx.seats?.get(a.id) ?? 0]),
];

export function pickBest(accounts: Account[], ctx: PickCtx): Account | null {
  const usable = accounts.filter((a) => a.id !== ctx.currentId && !a.needsReauth && !isExhausted(a, ctx));
  return sortBy(usable, swapPreference(ctx))[0] ?? null;
}

export function usableAt(a: Account, ctx: PickCtx): number {
  const blocking = blockingUntil(a, ctx).filter((t) => t > ctx.now);
  const at = blocking.length ? Math.max(...blocking) : ctx.now;
  const session = sessionWindow(a);
  const end = session != null ? windowEnd(session) : 0;
  return session != null && end > at && seatFull(a, { ...ctx, now: at }) ? end : at;
}

export type EarliestReset = { account: Account; availableAt: number };

export function pickEarliestReset(accounts: Account[], ctx: PickCtx): EarliestReset | null {
  const mapped = accounts
    .filter((a) => a.id !== ctx.currentId && !a.needsReauth)
    .map((a) => ({ account: a, availableAt: usableAt(a, ctx) }));
  return minBy(mapped, (x) => x.availableAt) ?? null;
}

export const MAX_WAITERS_PER_ACCOUNT = 8;

export function pickWaitTarget(accounts: Account[], ctx: PickCtx, waiters: Map<string, number>, cap: number, deadline: number, overflowDeadline: number): EarliestReset | null {
  const mapped = accounts
    .filter((a) => !a.needsReauth)
    .map((a) => ({ account: a, availableAt: usableAt(a, ctx) }))
    .filter((x) => x.availableAt <= overflowDeadline)
    .sort((x, y) => x.availableAt - y.availableAt || (x.account.id === ctx.currentId ? -1 : y.account.id === ctx.currentId ? 1 : 0));
  return (
    mapped.filter((x) => x.availableAt <= deadline).find((x) => (waiters.get(x.account.id) ?? 0) < cap) ??
    mapped.filter((x) => x.availableAt > deadline).find((x) => (waiters.get(x.account.id) ?? 0) < cap) ??
    sortBy(mapped, [(x) => waiters.get(x.account.id) ?? 0, (x) => x.availableAt, (x) => (x.account.id === ctx.currentId ? 0 : 1)])[0] ??
    null
  );
}
