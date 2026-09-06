import { minBy, sortBy } from "es-toolkit";
import { familyTokens } from "./usage.ts";
import type { Account, Config, Thresholds, UsageWindow } from "./types.ts";

export function sessionLadder(cfg: Config): number[] {
  return cfg.thresholds.session.map((rung) => rung - cfg.policy.projectionMargin);
}

export function terminalBars(cfg: Config): Thresholds {
  return {
    session: Math.max(...sessionLadder(cfg)),
    weekly: cfg.thresholds.weekly - cfg.policy.projectionMargin,
  };
}

export function effectiveBars(cfg: Config, pool: { accounts: Account[]; now: number; switchFamilies: string[] }): Thresholds {
  const top = terminalBars(cfg);
  const holdsAt = (session: number) =>
    pool.accounts.some(
      (a) => !a.needsReauth && !isExhausted(a, { now: pool.now, thresholds: { session, weekly: top.weekly }, currentAccountUuid: null, switchFamilies: pool.switchFamilies }),
    );
  return { session: sessionLadder(cfg).find(holdsAt) ?? top.session, weekly: top.weekly };
}

export function hardBars(cfg: Config): Thresholds {
  return {
    session: cfg.hardThresholds.session - cfg.policy.projectionMargin,
    weekly: cfg.hardThresholds.weekly - cfg.policy.projectionMargin,
  };
}

export type PickCtx = {
  now: number;
  thresholds: Thresholds;
  currentAccountUuid: string | null;
  switchFamilies: string[];
  holdMargin?: number;
};

export function liveUsed(input: { window: { usedPercentage: number; resetsAt: number | null }; windowMs: number | null; sampledAt: number | null; now: number }): number {
  const { window: w, windowMs, sampledAt, now } = input;
  if (w.resetsAt != null) return w.resetsAt <= now ? 0 : w.usedPercentage;
  if (sampledAt != null && windowMs != null && now >= sampledAt + windowMs) return 0;
  return w.usedPercentage;
}

function gatedPerModelWindows(a: Account, families: string[]): UsageWindow[] {
  return Object.entries(a.lastPerModel ?? {})
    .filter(([model]) => families.some((f) => familyTokens(model).includes(f)))
    .map(([, w]) => w);
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

function blockedUntil(w: UsageWindow, windowMs: number, sampledAt: number | undefined, threshold: number): number {
  if (w.usedPercentage < threshold) return 0;
  if (w.resetsAt != null) return w.resetsAt;
  return sampledAt != null ? sampledAt + windowMs : Number.POSITIVE_INFINITY;
}

function blockingUntil(a: Account, ctx: PickCtx): number[] {
  const u = a.lastUsage;
  return [
    ...(u
      ? [
          blockedUntil(u.fiveHour, FIVE_HOURS_MS, a.lastUsageAt, ctx.thresholds.session),
          blockedUntil(u.sevenDay, WEEK_MS, a.lastUsageAt, ctx.thresholds.weekly),
        ]
      : []),
    ...gatedPerModelWindows(a, ctx.switchFamilies).map((w) => blockedUntil(w, WEEK_MS, a.lastPerModelAt ?? a.lastUsageAt, ctx.thresholds.weekly)),
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
  return nextWeeklyReset(a.lastUsage?.sevenDay.resetsAt ?? null, now) ?? Number.POSITIVE_INFINITY;
}

export function earliestReset(a: Account, now: number): number {
  const fiveHour = a.lastUsage?.fiveHour.resetsAt;
  return Math.min(fiveHour != null && fiveHour > now ? fiveHour : Number.POSITIVE_INFINITY, weeklyExpiry(a, now));
}

export function pacePressure(a: Account, now: number): number {
  const cached = a.lastUsage?.sevenDay;
  const reset = nextWeeklyReset(cached?.resetsAt ?? null, now);
  if (cached == null || reset == null) return 0;
  const used = cached.resetsAt != null && cached.resetsAt <= now ? 0 : cached.usedPercentage;
  return Math.max(0, 100 - used) / Math.max(1, reset - now);
}

const swapPreference = (now: number) => [
  (a: Account) => -pacePressure(a, now),
  (a: Account) => weeklyExpiry(a, now),
  (a: Account) => a.lastUsage?.sevenDay.usedPercentage ?? 101,
];

export function pickBest(accounts: Account[], ctx: PickCtx): Account | null {
  const usable = accounts.filter(
    (a) => a.accountUuid !== ctx.currentAccountUuid && !a.needsReauth && !isExhausted(a, ctx),
  );
  return sortBy(usable, swapPreference(ctx.now))[0] ?? null;
}

export function currentWins(active: Account | null, accounts: Account[], ctx: PickCtx): boolean {
  if (!active || active.needsReauth || isExhausted(active, ctx)) return false;
  const best = pickBest(accounts, { ...ctx, currentAccountUuid: null });
  if (best == null || best.accountUuid === active.accountUuid) return true;
  const margin = ctx.holdMargin ?? 0;
  const bestPace = pacePressure(best, ctx.now);
  if (margin > 0 && bestPace > 0 && bestPace <= pacePressure(active, ctx.now) * (1 + margin)) return true;
  return swapPreference(ctx.now).every((k) => k(active) === k(best));
}

export function usableAt(a: Account, ctx: PickCtx): number {
  const blocking = blockingUntil(a, ctx).filter((t) => t > ctx.now);
  return blocking.length ? Math.max(...blocking) : ctx.now;
}

export type EarliestReset = { account: Account; availableAt: number };

export function pickEarliestReset(accounts: Account[], ctx: PickCtx): EarliestReset | null {
  const mapped = accounts
    .filter((a) => a.accountUuid !== ctx.currentAccountUuid && !a.needsReauth)
    .map((a) => ({ account: a, availableAt: usableAt(a, ctx) }))
    .filter((x) => Number.isFinite(x.availableAt));
  return minBy(mapped, (x) => x.availableAt) ?? null;
}
