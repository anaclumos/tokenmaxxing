import { maxBy, minBy, sortBy } from "es-toolkit";
import { familyTokens } from "./usage.ts";
import type { Account, Config, Thresholds, Window } from "./types.ts";

export function thresholdBars(cfg: Config): Thresholds {
  return {
    session: cfg.thresholds.session - cfg.policy.projectionMargin,
    weekly: cfg.thresholds.weekly,
  };
}

export type PickCtx = {
  now: number;
  thresholds: Thresholds;
  currentId: string | null;
  families: string[] | null;
  seats: Map<string, number> | null;
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

export function limitWindows(a: Account): Window[] {
  return a.windows.filter((w) => w.name != null);
}

export function gatedWindows(a: Account, families: string[] | null): Window[] {
  return a.windows.filter((w) => {
    const name = w.name;
    return name != null && (families == null || families.some((f) => familyTokens(name).includes(f)));
  });
}

export function liveUsed(w: Window, now: number): number {
  if (w.resetsAt != null) return w.resetsAt <= now ? 0 : w.usedPercentage;
  if (w.windowSeconds != null && now >= w.sampledAt + w.windowSeconds * 1000) return 0;
  return w.usedPercentage;
}

function barFor(w: Window, thresholds: Thresholds): number {
  return isSessionWindow(w) ? thresholds.session : thresholds.weekly;
}

function blockedUntil(w: Window, bar: number): number {
  if (w.usedPercentage < bar) return 0;
  if (w.resetsAt != null) return w.resetsAt;
  return w.windowSeconds != null ? w.sampledAt + w.windowSeconds * 1000 : Number.POSITIVE_INFINITY;
}

function blockingUntil(a: Account, ctx: PickCtx): number[] {
  return [
    ...a.windows.filter((w) => w.name == null).map((w) => blockedUntil(w, barFor(w, ctx.thresholds))),
    ...gatedWindows(a, ctx.families).map((w) => blockedUntil(w, barFor(w, ctx.thresholds))),
    ...(a.enforcedUntil != null ? [a.enforcedUntil] : []),
  ];
}

export function isExhausted(a: Account, ctx: PickCtx): boolean {
  return blockingUntil(a, ctx).some((t) => t > ctx.now);
}

export function nextWeeklyReset(resetsAt: number | null, now: number): number | null {
  if (resetsAt == null || resetsAt > now) return resetsAt;
  return resetsAt + (Math.floor((now - resetsAt) / WEEK_MS) + 1) * WEEK_MS;
}

export function weeklyExpiry(a: Account, now: number): number {
  return nextWeeklyReset(weeklyWindow(a)?.resetsAt ?? null, now) ?? Number.POSITIVE_INFINITY;
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
  return (ctx.thresholds.session - liveUsed(session, ctx.now)) / ((ctx.seats?.get(a.id) ?? 0) + 1);
}

const swapPreference = (ctx: PickCtx) => [
  ...(ctx.seats == null ? [] : [(a: Account) => -seatHeadroom(a, ctx)]),
  (a: Account) => -pacePressure(a, ctx),
  (a: Account) => weeklyExpiry(a, ctx.now),
  (a: Account) => weeklyWindow(a)?.usedPercentage ?? 101,
];

export function pickBest(accounts: Account[], ctx: PickCtx): Account | null {
  const usable = accounts.filter((a) => a.id !== ctx.currentId && !a.needsReauth && !isExhausted(a, ctx));
  return sortBy(usable, swapPreference(ctx))[0] ?? null;
}

export function usableAt(a: Account, ctx: PickCtx): number {
  const blocking = blockingUntil(a, ctx).filter((t) => t > ctx.now);
  return blocking.length ? Math.max(...blocking) : ctx.now;
}

export type EarliestReset = { account: Account; availableAt: number };

export function pickEarliestReset(accounts: Account[], ctx: PickCtx): EarliestReset | null {
  const mapped = accounts
    .filter((a) => a.id !== ctx.currentId && !a.needsReauth)
    .map((a) => ({ account: a, availableAt: usableAt(a, ctx) }))
    .filter((x) => Number.isFinite(x.availableAt));
  return minBy(mapped, (x) => x.availableAt) ?? null;
}

export function pickWaitTarget(accounts: Account[], ctx: PickCtx, waiters: Map<string, number>, cap: number): EarliestReset | null {
  const mapped = accounts
    .filter((a) => !a.needsReauth)
    .map((a) => ({ account: a, availableAt: usableAt(a, ctx) }))
    .filter((x) => Number.isFinite(x.availableAt))
    .sort((x, y) => x.availableAt - y.availableAt || (x.account.id === ctx.currentId ? -1 : y.account.id === ctx.currentId ? 1 : 0));
  return mapped.find((x) => (waiters.get(x.account.id) ?? 0) < cap) ?? mapped[0] ?? null;
}
