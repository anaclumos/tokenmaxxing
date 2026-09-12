import { maxBy, minBy, sortBy } from "es-toolkit";
import { z } from "zod";
import { familyTokens } from "./usage.ts";
import { AccountSchema, ThresholdsSchema, type Account, type Config, type Thresholds, type Window } from "./types.ts";

export function thresholdBars(cfg: Config): Thresholds {
  return {
    session: cfg.thresholds.session - cfg.policy.projectionMargin,
    weekly: cfg.thresholds.weekly - cfg.policy.projectionMargin,
  };
}

const PickCtxSchema = z.object({
  now: z.number(),
  thresholds: ThresholdsSchema,
  currentId: z.string().nullable(),
  families: z.array(z.string()).nullable(),
});
export type PickCtx = z.infer<typeof PickCtxSchema>;

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

export function pacePressure(a: Account, now: number): number {
  const weekly = weeklyWindow(a);
  const reset = nextWeeklyReset(weekly?.resetsAt ?? null, now);
  if (weekly == null || reset == null) return 0;
  return Math.max(0, 100 - liveUsed(weekly, now)) / Math.max(1, reset - now);
}

const swapPreference = (ctx: PickCtx) => [
  (a: Account) => -pacePressure(a, ctx.now),
  (a: Account) => weeklyExpiry(a, ctx.now),
  (a: Account) => weeklyWindow(a)?.usedPercentage ?? 101,
];

export function pickBest(accounts: Account[], ctx: PickCtx): Account | null {
  const usable = accounts.filter((a) => a.id !== ctx.currentId && !a.needsReauth && !isExhausted(a, ctx));
  return sortBy(usable, swapPreference(ctx))[0] ?? null;
}

export function currentWins(active: Account | null, accounts: Account[], ctx: PickCtx, margin = 1): boolean {
  if (!active || active.needsReauth || isExhausted(active, ctx)) return false;
  const best = pickBest(accounts, { ...ctx, currentId: null });
  if (best == null || best.id === active.id) return true;
  if (margin > 1) return pacePressure(best, ctx.now) <= pacePressure(active, ctx.now) * margin;
  return swapPreference(ctx).every((k) => k(active) === k(best));
}

export function usableAt(a: Account, ctx: PickCtx): number {
  const blocking = blockingUntil(a, ctx).filter((t) => t > ctx.now);
  return blocking.length ? Math.max(...blocking) : ctx.now;
}

const EarliestResetSchema = z.object({ account: AccountSchema, availableAt: z.number() });
export type EarliestReset = z.infer<typeof EarliestResetSchema>;

export function pickEarliestReset(accounts: Account[], ctx: PickCtx): EarliestReset | null {
  const mapped = accounts
    .filter((a) => a.id !== ctx.currentId && !a.needsReauth)
    .map((a) => ({ account: a, availableAt: usableAt(a, ctx) }))
    .filter((x) => Number.isFinite(x.availableAt));
  return minBy(mapped, (x) => x.availableAt) ?? null;
}
