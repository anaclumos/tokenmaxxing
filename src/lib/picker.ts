import { minBy, sortBy } from "es-toolkit";
import { z } from "zod";
import { familyTokens } from "./usage.ts";
import { AccountSchema, ThresholdsSchema, type Account, type Config, type Thresholds, type UsageWindow } from "./types.ts";

export function effectiveBars(cfg: Config): Thresholds {
  return {
    session: cfg.thresholds.session - cfg.policy.projectionMargin,
    weekly: cfg.thresholds.weekly - cfg.policy.projectionMargin,
  };
}

export function hardBars(cfg: Config): Thresholds {
  return {
    session: cfg.hardThresholds.session - cfg.policy.projectionMargin,
    weekly: cfg.hardThresholds.weekly - cfg.policy.projectionMargin,
  };
}

const PickCtxSchema = z.object({
  now: z.number(),
  thresholds: ThresholdsSchema,
  currentAccountUuid: z.string().nullable(),
  switchFamilies: z.array(z.string()),
});
export type PickCtx = z.infer<typeof PickCtxSchema>;

function gatedPerModelWindows(a: Account, families: string[]): UsageWindow[] {
  return Object.entries(a.lastPerModel ?? {})
    .filter(([model]) => families.some((f) => familyTokens(model).includes(f)))
    .map(([, w]) => w);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

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
  return swapPreference(ctx.now).every((k) => k(active) === k(best));
}

export function usableAt(a: Account, ctx: PickCtx): number {
  const blocking = blockingUntil(a, ctx).filter((t) => t > ctx.now);
  return blocking.length ? Math.max(...blocking) : ctx.now;
}

const EarliestResetSchema = z.object({ account: AccountSchema, availableAt: z.number() });
export type EarliestReset = z.infer<typeof EarliestResetSchema>;

export function pickEarliestReset(accounts: Account[], ctx: PickCtx): EarliestReset | null {
  const mapped = accounts
    .filter((a) => a.accountUuid !== ctx.currentAccountUuid && !a.needsReauth)
    .map((a) => ({ account: a, availableAt: usableAt(a, ctx) }))
    .filter((x) => Number.isFinite(x.availableAt));
  return minBy(mapped, (x) => x.availableAt) ?? null;
}
