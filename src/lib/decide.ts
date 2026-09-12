import { maxBy } from "es-toolkit";
import { z } from "zod";
import { withLock } from "./lock.ts";
import { paths } from "./paths.ts";
import { POST_SWAP_COOLDOWN_MS, loadAccounts, loadConfig, loadDepletedWait, loadLastSwapAt, loadUsage, loadUsageSnapshot, saveAccounts, saveDepletedWait, writeUsage } from "./state.ts";
import { readOAuthAccount } from "./claudejson.ts";
import { isSkippableSwapError, performSwap } from "./swap.ts";
import { nextWeeklyReset, pickBest, pickEarliestReset, thresholdBars, usableAt } from "./picker.ts";
import { familyTokens, gatedFamilies, keepRows, probeUsage, type EnforcedClass } from "./usage.ts";
import { log } from "./log.ts";
import { AccountSchema, UsageStateSchema, type Account, type Config, type EnforcedLimit, type Thresholds, type UsageState, type UsageWindow } from "./types.ts";

const SwapDecisionSchema = z.object({
  swapped: z.boolean(),
  account: AccountSchema.nullable(),
  reason: z.string(),
  waitUntil: z.number().optional(),
});
export type SwapDecision = z.infer<typeof SwapDecisionSchema>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

function liveUsed(input: { window: UsageWindow; windowMs: number; sampledAt: number; now: number }): number {
  const { window: w, windowMs, sampledAt, now } = input;
  if (w.resetsAt != null) return w.resetsAt <= now ? 0 : w.usedPercentage;
  if (now >= sampledAt + windowMs) return 0;
  return w.usedPercentage;
}

function rowsSampledAt(account: Account, now: number): number {
  return account.lastUsage?.rowsAt ?? account.lastUsageAt ?? now;
}

function capForFamily(account: Account, family: string, now: number): UsageWindow | undefined {
  const rows = Object.entries(account.lastUsage?.perModel ?? {})
    .filter(([k]) => familyTokens(k).includes(family))
    .map(([, w]) => w);
  return maxBy(rows, (w) => liveUsed({ window: w, windowMs: WEEK_MS, sampledAt: rowsSampledAt(account, now), now }));
}

function isOver(u: UsageState | null, account: Account | undefined, bars: Thresholds, cfg: Config, now: number): boolean {
  if (!u || !account || u.account !== account.accountUuid) return false;
  if (
    liveUsed({ window: u.fiveHour, windowMs: FIVE_HOURS_MS, sampledAt: u.ts, now }) >= bars.session ||
    liveUsed({ window: u.sevenDay, windowMs: WEEK_MS, sampledAt: u.ts, now }) >= bars.weekly
  ) return true;
  for (const family of gatedFamilies(u.model, cfg.policy.switchModels)) {
    const cap = capForFamily(account, family, now);
    if (cap && liveUsed({ window: cap, windowMs: WEEK_MS, sampledAt: rowsSampledAt(account, now), now }) >= bars.weekly) return true;
  }
  return false;
}

function needsPerModel(u: UsageState | null, cfg: Config): boolean {
  return u != null && gatedFamilies(u.model, cfg.policy.switchModels).length > 0;
}

const SnapshotsSchema = z.object({
  u: UsageStateSchema.nullable(),
  uAt: z.number().nullable(),
});
type Snapshots = z.infer<typeof SnapshotsSchema>;

function usageFresh(u: UsageState | null, uAt: number | null, account: string | null, ttl: number, now: number): boolean {
  return u != null && u.account === account && uAt != null && now - uAt <= ttl;
}

function freshest(u: UsageState | null, uAt: number | null, account: Account | undefined): UsageState | null {
  if (!u || uAt == null) return u;
  const stored = account?.lastUsage;
  if (stored && account.lastUsageAt != null && u.account === account.accountUuid && uAt < account.lastUsageAt) {
    return { ...u, fiveHour: stored.fiveHour, sevenDay: stored.sevenDay, ts: account.lastUsageAt };
  }
  return { ...u, ts: uAt };
}

async function loadFreshSnapshots(cfg: Config, account: string | null, now: number): Promise<Snapshots> {
  const snap = loadUsageSnapshot();
  let u = snap?.state ?? null;
  let uAt = snap?.at ?? null;
  const ttl = cfg.policy.usagePollTtlMs;
  const stored = loadAccounts().accounts.find((a) => a.accountUuid === account);
  const probeAttempted = stored?.lastProbeAt != null && now - stored.lastProbeAt <= ttl;
  if (account && stored && !probeAttempted && (!usageFresh(u, uAt, account, ttl, now) || needsPerModel(u, cfg))) {
    const full = await probeUsage();
    const ts = Date.now();
    if (readOAuthAccount()?.accountUuid === account) {
      if (full) {
        const teed = loadUsageSnapshot();
        if (teed && usageFresh(teed.state, teed.at, account, ttl, ts)) {
          u = teed.state;
          uAt = teed.at;
        } else {
          u = { fiveHour: full.fiveHour, sevenDay: full.sevenDay, account, ts, model: null };
          writeUsage(u);
          uAt = ts;
        }
        const expected = gatedFamilies(u?.model ?? null, cfg.policy.switchModels);
        const rows = Object.keys(full.perModel);
        if (expected.length > 0 && !expected.some((f) => rows.some((k) => familyTokens(k).includes(f)))) {
          log("usage.no_permodel_row", { families: expected.join(","), rows: rows.join(",") });
        }
      }
      await withLock(paths.lockFile, () => {
        const idx = loadAccounts();
        const a = idx.accounts.find((x) => x.accountUuid === account);
        if (!a) return;
        a.lastProbeAt = ts;
        if (full) {
          a.lastUsage = keepRows(full, a.lastUsage, ts);
          a.lastUsageAt = ts;
        }
        saveAccounts(idx);
      });
    }
  }
  return { u, uAt };
}

export async function evaluateAndMaybeSwap(now = Date.now(), anticipatory = false, enforced: EnforcedLimit | null = null): Promise<SwapDecision> {
  const activeAccount = readOAuthAccount()?.accountUuid ?? null;
  const enforced0 = enforced && enforced.account === activeAccount ? enforced : null;

  const lastSwapAt = loadLastSwapAt();
  if (!enforced0 && lastSwapAt != null && now - lastSwapAt < POST_SWAP_COOLDOWN_MS) {
    return depletedReplay(now) ?? { swapped: false, account: null, reason: "post-swap-cooldown" };
  }

  const cfg = loadConfig();
  const bars = thresholdBars(cfg);

  const { u: teeUsage, uAt } = await loadFreshSnapshots(cfg, activeAccount, now);
  const stored = loadAccounts().accounts.find((a) => a.accountUuid === activeAccount);
  const usage = freshest(teeUsage, uAt, stored);

  if (!enforced0 && !isOver(usage, stored, bars, cfg, now)) {
    const measured = usage != null && activeAccount != null && usage.account === activeAccount;
    if (!measured) {
      const replay = depletedReplay(now);
      if (replay) return replay;
    }
    return { swapped: false, account: null, reason: "under-threshold-or-stale" };
  }

  return withLock(paths.lockFile, async () => {
    const idx = loadAccounts();
    const account2 = readOAuthAccount()?.accountUuid ?? null;
    const enforced2 = enforced0 && enforced0.account === account2 ? enforced0 : null;
    const tee = loadUsageSnapshot();
    const active = account2 ? idx.accounts.find((a) => a.accountUuid === account2) : undefined;
    const u2 = tee ? freshest(tee.state, tee.at, active) : usage;

    if (account2 != null && !active) {
      return { swapped: false, account: null, reason: "live-credential-not-in-pool" };
    }

    if (active && tee && tee.state.account === account2 && (active.lastUsageAt == null || tee.at >= active.lastUsageAt)) {
      active.lastUsageAt = tee.state.sampledAt ?? tee.at;
      active.lastUsage = keepRows({ fiveHour: tee.state.fiveHour, sevenDay: tee.state.sevenDay, perModel: {} }, active.lastUsage, active.lastUsageAt);
      saveAccounts(idx);
    }

    const gated = gatedFamilies(u2?.model ?? null, cfg.policy.switchModels);
    const switchFamilies = enforced2?.family && !gated.includes(enforced2.family) ? [...gated, enforced2.family] : gated;

    if (!enforced2 && !isOver(u2, active, bars, cfg, now)) {
      return depletedReplay(now) ?? { swapped: false, account: null, reason: "raced-already-swapped" };
    }

    const seatOf = (idx2: { activeAccountUuid: string | null; accounts: Account[] }): Account | null =>
      idx2.accounts.find((a) => a.accountUuid === account2) ??
      idx2.accounts.find((a) => a.accountUuid === idx2.activeAccountUuid) ??
      null;

    const rejected = new Set<string>();
    const usable = (accounts: Account[]): Account[] => accounts.filter((a) => !rejected.has(a.accountUuid));
    const skipOrThrow = (e: unknown, candidate: Account): void => {
      if (!isSkippableSwapError(e)) throw e;
      rejected.add(candidate.accountUuid);
      log("decide.candidate_rejected", { account: candidate.accountUuid.slice(0, 8), error: e instanceof Error ? e.message : String(e) });
    };
    while (true) {
      const cur = loadAccounts();
      const seat = seatOf(cur);
      const ctx = { now, thresholds: bars, currentAccountUuid: seat?.accountUuid ?? null, switchFamilies };
      const best = pickBest(usable(cur.accounts), ctx);
      if (!best) break;
      try {
        await performSwap(best);
      } catch (e) {
        skipOrThrow(e, best);
        continue;
      }
      log("decide.swap", { account: best.accountUuid.slice(0, 8), enforced: enforced2 != null });
      return { swapped: true, account: best, reason: "swapped" };
    }

    while (true) {
      const fresh = loadAccounts();
      const current = seatOf(fresh);
      const ctx = { now, thresholds: bars, currentAccountUuid: current?.accountUuid ?? null, switchFamilies };
      const enforcedUntil = enforced2 && current && current.accountUuid === enforced2.account ? (enforced2.resetsAt ?? now + enforced2.windowMs) : 0;
      const currentAt = current ? Math.max(usableAt(current, ctx), enforcedUntil) : Number.POSITIVE_INFINITY;
      const other = pickEarliestReset(usable(fresh.accounts), ctx);

      let target: Account | null = null;
      let waitUntil = Number.POSITIVE_INFINITY;
      if (other && other.availableAt < currentAt) { target = other.account; waitUntil = other.availableAt; }
      else if (current) { target = current; waitUntil = currentAt; }
      else if (other) { target = other.account; waitUntil = other.availableAt; }

      if (!target || waitUntil - now > cfg.policy.maxWaitMs) {
        log("decide.depleted", { waitUntil: Number.isFinite(waitUntil) ? waitUntil : 0 });
        return { swapped: false, account: null, reason: "all-depleted", ...(Number.isFinite(waitUntil) ? { waitUntil } : {}) };
      }

      const isCurrent = target.accountUuid === (current?.accountUuid ?? null);
      if (!isCurrent && !anticipatory) {
        log("decide.depleted_no_park", { account: target.accountUuid.slice(0, 8), waitUntil });
        return { swapped: false, account: null, reason: "all-depleted", waitUntil };
      }
      if (!isCurrent) {
        try {
          await performSwap(target);
        } catch (e) {
          skipOrThrow(e, target);
          continue;
        }
      }
      saveDepletedWait({ waitUntil, accountUuid: target.accountUuid, ts: now });
      log("decide.depleted_wait", { account: target.accountUuid.slice(0, 8), waitUntil });
      return { swapped: !isCurrent, account: target, reason: "depleted-wait", waitUntil };
    }
  });
}

function depletedReplay(now: number): SwapDecision | null {
  const rec = loadDepletedWait();
  if (!rec || rec.waitUntil <= now) return null;
  const account = loadAccounts().accounts.find((a) => a.accountUuid === rec.accountUuid) ?? null;
  if (!account) return null;
  if (account.accountUuid !== (readOAuthAccount()?.accountUuid ?? null)) return null;
  return { swapped: false, account, reason: "depleted-wait", waitUntil: rec.waitUntil };
}

export function enforcedWindowMs(limit: EnforcedClass): number {
  return limit.kind === "session" ? FIVE_HOURS_MS : WEEK_MS;
}

export function postSwapProof(input: { swapAt: number | null; launchedAt: number | null; errorAt: number | null; now: number }): boolean {
  const { swapAt, launchedAt, errorAt, now } = input;
  if (swapAt == null) return true;
  if (launchedAt != null && launchedAt > swapAt) return true;
  return (errorAt ?? now) - swapAt >= POST_SWAP_COOLDOWN_MS;
}

const StampSchema = z.object({ outcome: z.enum(["stamped", "account-moved", "no-carrier"]), resetsAt: z.number().nullable() });
export type Stamp = z.infer<typeof StampSchema>;

export async function recordEnforcedLimit(input: { limit: EnforcedClass; account: string; now: number }): Promise<Stamp> {
  const { limit, account: accountUuid, now } = input;
  return withLock(paths.lockFile, () => {
    if ((readOAuthAccount()?.accountUuid ?? null) !== accountUuid) return { outcome: "account-moved", resetsAt: limit.resetsAt };
    const prior = loadUsage();
    const priorSame = prior && prior.account === accountUuid ? prior : null;
    const idx = loadAccounts();
    const account = idx.accounts.find((a) => a.accountUuid === accountUuid);
    if (limit.kind === "model") {
      const rows = account?.lastUsage?.perModel ?? {};
      const knownReset = Object.entries(rows).filter(([k]) => familyTokens(k).includes(limit.family)).map(([, w]) => w.resetsAt).find((r): r is number => r != null) ?? null;
      const weeklyReset = priorSame?.sevenDay.resetsAt ?? account?.lastUsage?.sevenDay.resetsAt ?? null;
      const resetsAt = limit.resetsAt ?? nextWeeklyReset(knownReset ?? weeklyReset, now);
      if (!account) return { outcome: "no-carrier", resetsAt };
      if (account.lastUsage) {
        account.lastUsage = { ...account.lastUsage, perModel: { ...rows, [limit.family]: { usedPercentage: 100, resetsAt } }, rowsAt: now };
      } else {
        account.enforcedUntil = resetsAt ?? now + WEEK_MS;
      }
      account.lastProbeAt = now;
      saveAccounts(idx);
      log("usage.enforced_limit", { kind: limit.kind, family: limit.family, resetsAt });
      return { outcome: "stamped", resetsAt };
    }
    if (account) {
      account.lastProbeAt = now;
      if (limit.resetsAt != null) account.enforcedUntil = limit.resetsAt;
      saveAccounts(idx);
    }
    const carrier = priorSame ?? (account?.lastUsage ? { ...account.lastUsage, model: null } : null);
    if (!carrier) return { outcome: "no-carrier", resetsAt: limit.resetsAt };
    const window: UsageWindow = { usedPercentage: 100, resetsAt: limit.resetsAt };
    writeUsage({
      ...(priorSame ?? {}),
      ...(priorSame == null && account?.lastUsageAt != null ? { sampledAt: account.lastUsageAt } : {}),
      fiveHour: limit.kind === "session" ? window : carrier.fiveHour,
      sevenDay: limit.kind === "weekly" ? window : carrier.sevenDay,
      account: accountUuid,
      ts: now,
      model: carrier.model,
    }, { stamp: true });
    log("usage.enforced_limit", { kind: limit.kind, resetsAt: limit.resetsAt });
    return { outcome: "stamped", resetsAt: limit.resetsAt };
  });
}
