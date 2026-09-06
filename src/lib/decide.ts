import { maxBy } from "es-toolkit";
import { z } from "zod";
import { withLock } from "./lock.ts";
import { paths } from "./paths.ts";
import { MAX_CHECK_DELAY_TICKS, POST_SWAP_COOLDOWN_MS, maxCheckDelayMs, loadAccounts, loadConfig, loadDepletedWait, loadLastSwapAt, loadUsage, loadUsageSnapshot, loadModelUsage, saveAccounts, saveDepletedWait, saveModelUsage, writeUsage } from "./state.ts";
import { readOAuthAccount } from "./claudejson.ts";
import { chooseAndSwap, performSwap } from "./swap.ts";
import { currentWins, effectiveBars, hardBars, isExhausted, nextWeeklyReset, pickBest, pickEarliestReset, sessionLadder, usableAt } from "./picker.ts";
import { InvalidGrantError } from "./oauth.ts";
import { familyTokens, gatedFamilies, probeUsage, type EnforcedClass } from "./usage.ts";
import { log } from "./log.ts";
import { AccountSchema, ModelUsageStateSchema, UsageStateSchema, type Account, type Config, type EnforcedLimit, type ModelUsageState, type Thresholds, type UsageState, type UsageWindow } from "./types.ts";

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

function capForFamily(mu: ModelUsageState, family: string, now: number): UsageWindow | undefined {
  const rows = Object.entries(mu.perModel)
    .filter(([k]) => familyTokens(k).includes(family))
    .map(([, w]) => w);
  return maxBy(rows, (w) => liveUsed({ window: w, windowMs: WEEK_MS, sampledAt: mu.sampledAt ?? mu.ts, now }));
}

function overlayLive(accounts: Account[], u: UsageState | null, mu: ModelUsageState | null, account: string | null): Account[] {
  return accounts.map((a) => {
    if (account == null || a.accountUuid !== account) return a;
    const live = u && u.account === account ? { lastUsage: { fiveHour: u.fiveHour, sevenDay: u.sevenDay }, lastUsageAt: u.ts } : {};
    const perModel = mu && mu.account === account && Object.keys(mu.perModel).length > 0 ? { lastPerModel: mu.perModel, lastPerModelAt: mu.sampledAt ?? mu.ts } : {};
    return { ...a, ...live, ...perModel };
  });
}

function isOver(u: UsageState | null, mu: ModelUsageState | null, account: string | null, bars: Thresholds, cfg: Config, now: number): boolean {
  if (!u || !account || u.account !== account) return false;
  if (
    liveUsed({ window: u.fiveHour, windowMs: FIVE_HOURS_MS, sampledAt: u.ts, now }) >= bars.session ||
    liveUsed({ window: u.sevenDay, windowMs: WEEK_MS, sampledAt: u.ts, now }) >= bars.weekly
  ) return true;
  if (mu && mu.account === account) {
    for (const family of gatedFamilies(u.model, cfg.policy.switchModels)) {
      const cap = capForFamily(mu, family, now);
      if (cap && liveUsed({ window: cap, windowMs: WEEK_MS, sampledAt: mu.sampledAt ?? mu.ts, now }) >= bars.weekly) return true;
    }
  }
  return false;
}

function needsPerModel(u: UsageState | null, cfg: Config): boolean {
  return u != null && gatedFamilies(u.model, cfg.policy.switchModels).length > 0;
}

function isEngaged(u: UsageState | null, mu: ModelUsageState | null, account: string | null, bars: Thresholds, cfg: Config, now: number): boolean {
  if (!u || !account || u.account !== account) return false;
  return liveUsed({ window: u.fiveHour, windowMs: FIVE_HOURS_MS, sampledAt: u.ts, now }) >= cfg.policy.greedySessionFloor || isOver(u, mu, account, bars, cfg, now);
}

const SnapshotsSchema = z.object({
  u: UsageStateSchema.nullable(),
  mu: ModelUsageStateSchema.nullable(),
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
  let mu = loadModelUsage();
  const ttl = cfg.policy.usagePollTtlMs;
  const probeAttempted = mu != null && mu.account === account && now - mu.ts <= ttl;
  if (account && !probeAttempted && (!usageFresh(u, uAt, account, ttl, now) || needsPerModel(u, cfg))) {
    const full = await probeUsage();
    const ts = Date.now();
    if (readOAuthAccount()?.accountUuid === account) {
      if (full) {
        const teed = loadUsageSnapshot();
        if (teed && usageFresh(teed.state, teed.at, account, ttl, ts)) {
          u = teed.state;
          uAt = teed.at;
        } else {
          u = { fiveHour: full.session, sevenDay: full.weekAll, account, ts, model: null };
          writeUsage(u);
          uAt = ts;
        }
        mu = { perModel: full.perModel, account, ts, sampledAt: ts };
        saveModelUsage(mu);
        const expected = gatedFamilies(u?.model ?? null, cfg.policy.switchModels);
        const rows = Object.keys(full.perModel);
        if (expected.length > 0 && !expected.some((f) => rows.some((k) => familyTokens(k).includes(f)))) {
          log("usage.no_permodel_row", { families: expected.join(","), rows: rows.join(",") });
        }
      } else {
        mu = { perModel: mu?.account === account ? (mu?.perModel ?? {}) : {}, account, ts, sampledAt: mu?.account === account ? (mu?.sampledAt ?? mu?.ts) : undefined };
        saveModelUsage(mu);
      }
    }
  }
  return { u, mu, uAt };
}

export async function evaluateAndMaybeSwap(now = Date.now(), anticipatory = false, enforced: EnforcedLimit | null = null): Promise<SwapDecision> {
  const activeAccount = readOAuthAccount()?.accountUuid ?? null;
  const enforced0 = enforced && enforced.account === activeAccount ? enforced : null;

  const lastSwapAt = loadLastSwapAt();
  if (!enforced0 && lastSwapAt != null && now - lastSwapAt < POST_SWAP_COOLDOWN_MS) {
    return depletedReplay(now) ?? { swapped: false, account: null, reason: "post-swap-cooldown" };
  }

  const cfg = loadConfig();

  const { u: teeUsage, mu, uAt } = await loadFreshSnapshots(cfg, activeAccount, now);
  const pool = loadAccounts();
  const usage = freshest(teeUsage, uAt, pool.accounts.find((a) => a.accountUuid === activeAccount));
  const bars0 = effectiveBars(cfg, {
    accounts: overlayLive(pool.accounts, usage, mu, activeAccount),
    now,
    switchFamilies: gatedFamilies(usage?.model ?? null, cfg.policy.switchModels),
  });

  if (!enforced0 && !isEngaged(usage, mu, activeAccount, bars0, cfg, now)) {
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
    const mu2 = needsPerModel(u2, cfg) || enforced2?.family ? loadModelUsage() ?? mu : null;

    if (account2 != null && !active) {
      return { swapped: false, account: null, reason: "live-credential-not-in-pool" };
    }

    if (active) {
      let sampled = false;
      if (tee && tee.state.account === account2 && (active.lastUsageAt == null || tee.at >= active.lastUsageAt)) {
        active.lastUsage = { fiveHour: tee.state.fiveHour, sevenDay: tee.state.sevenDay };
        active.lastUsageAt = tee.at;
        sampled = true;
      }
      if (mu2 && mu2.account === account2 && Object.keys(mu2.perModel).length > 0) {
        active.lastPerModel = mu2.perModel;
        active.lastPerModelAt = mu2.sampledAt ?? mu2.ts;
        sampled = true;
      }
      if (sampled) saveAccounts(idx);
    }

    const gated = gatedFamilies(u2?.model ?? null, cfg.policy.switchModels);
    const switchFamilies = enforced2?.family && !gated.includes(enforced2.family) ? [...gated, enforced2.family] : gated;
    const barsOf = (accounts: Account[]): Thresholds => effectiveBars(cfg, { accounts, now, switchFamilies });
    const bars = barsOf(idx.accounts);

    if (!enforced2 && !isEngaged(u2, mu2, account2, bars, cfg, now)) {
      return depletedReplay(now) ?? { swapped: false, account: null, reason: "raced-already-swapped" };
    }

    const seatOf = (idx2: { activeAccountUuid: string | null; accounts: Account[] }): Account | null =>
      idx2.accounts.find((a) => a.accountUuid === account2) ??
      idx2.accounts.find((a) => a.accountUuid === idx2.activeAccountUuid) ??
      null;

    const greedy = async (holdMargin: number): Promise<SwapDecision> => {
      while (true) {
        const cur = loadAccounts();
        const active = seatOf(cur);
        const ctxAll = { now, thresholds: barsOf(cur.accounts), currentAccountUuid: null, switchFamilies, holdMargin };
        if (currentWins(active, cur.accounts, ctxAll)) {
          return { swapped: false, account: null, reason: "current-best" };
        }
        const best = pickBest(cur.accounts, { ...ctxAll, currentAccountUuid: active?.accountUuid ?? null });
        if (!best) return { swapped: false, account: null, reason: "no-usable-target" };
        try {
          await performSwap(best);
        } catch (e) {
          if (e instanceof InvalidGrantError) continue;
          throw e;
        }
        log("decide.greedy_swap", { account: best.accountUuid.slice(0, 8) });
        return { swapped: true, account: best, reason: "swapped" };
      }
    };
    if (!enforced2 && !isOver(u2, mu2, account2, bars, cfg, now)) return greedy(cfg.policy.greedySwapMargin);

    while (true) {
      const cur = loadAccounts();
      const seat = seatOf(cur);
      const thresholds = barsOf(cur.accounts);
      if (!enforced2 && seat && !seat.needsReauth && !isExhausted(seat, { now, thresholds, currentAccountUuid: null, switchFamilies })) return greedy(0);
      const best = pickBest(cur.accounts, { now, thresholds, currentAccountUuid: seat?.accountUuid ?? null, switchFamilies });
      if (!best) break;
      try {
        await performSwap(best);
      } catch (e) {
        if (e instanceof InvalidGrantError) continue;
        throw e;
      }
      return { swapped: true, account: best, reason: "swapped" };
    }

    const hardCtx = { now, thresholds: hardBars(cfg), currentAccountUuid: null, switchFamilies };
    const seat = seatOf(loadAccounts());
    if (!enforced2 && seat && !seat.needsReauth && !isExhausted(seat, hardCtx)) {
      log("decide.last_drop_hold", { account: seat.accountUuid.slice(0, 8) });
      return { swapped: false, account: null, reason: "last-drop-hold" };
    }
    const squeezed = await chooseAndSwap({ ...hardCtx, currentAccountUuid: seat?.accountUuid ?? null });
    if (squeezed) {
      log("decide.last_drop_swap", { account: squeezed.accountUuid.slice(0, 8) });
      return { swapped: true, account: squeezed, reason: "last-drop-swap" };
    }

    while (true) {
      const fresh = loadAccounts();
      const current = seatOf(fresh);
      const ctx = { now, thresholds: hardBars(cfg), currentAccountUuid: current?.accountUuid ?? null, switchFamilies };
      const enforcedUntil = enforced2 && current && current.accountUuid === enforced2.account ? (enforced2.resetsAt ?? now + enforced2.windowMs) : 0;
      const currentAt = current ? Math.max(usableAt(current, ctx), enforcedUntil) : Number.POSITIVE_INFINITY;
      const other = pickEarliestReset(fresh.accounts, ctx);

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
          if (e instanceof InvalidGrantError) continue;
          throw e;
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
    const mu = loadModelUsage();
    const muSame = mu && mu.account === accountUuid ? mu : null;
    const carriedRows = muSame?.perModel ?? {};
    const sampledAt = muSame?.sampledAt ?? muSame?.ts;
    if (limit.kind === "model") {
      const rowsFor = (rows: Record<string, UsageWindow>) => Object.entries(rows).filter(([k]) => familyTokens(k).includes(limit.family)).map(([, w]) => w);
      const knownReset = [...rowsFor(carriedRows), ...rowsFor(account?.lastPerModel ?? {})].map((w) => w.resetsAt).find((r): r is number => r != null) ?? null;
      const weeklyReset = priorSame?.sevenDay.resetsAt ?? account?.lastUsage?.sevenDay.resetsAt ?? null;
      const resetsAt = limit.resetsAt ?? nextWeeklyReset(knownReset ?? weeklyReset, now);
      saveModelUsage({
        perModel: { ...carriedRows, [limit.family]: { usedPercentage: 100, resetsAt } },
        account: accountUuid,
        ts: now,
        sampledAt: resetsAt == null ? now : sampledAt ?? now,
      });
      log("usage.enforced_limit", { kind: limit.kind, family: limit.family, resetsAt });
      return { outcome: "stamped", resetsAt };
    }
    saveModelUsage({ perModel: carriedRows, account: accountUuid, ts: now, sampledAt });
    if (account && limit.resetsAt != null) {
      account.enforcedUntil = limit.resetsAt;
      saveAccounts(idx);
    }
    const carrier = priorSame ?? (account?.lastUsage ? { ...account.lastUsage, model: null } : null);
    if (!carrier) return { outcome: "no-carrier", resetsAt: limit.resetsAt };
    const window: UsageWindow = { usedPercentage: 100, resetsAt: limit.resetsAt };
    writeUsage({
      fiveHour: limit.kind === "session" ? window : carrier.fiveHour,
      sevenDay: limit.kind === "weekly" ? window : carrier.sevenDay,
      account: accountUuid,
      ts: now,
      model: carrier.model,
    });
    log("usage.enforced_limit", { kind: limit.kind, resetsAt: limit.resetsAt });
    return { outcome: "stamped", resetsAt: limit.resetsAt };
  });
}

const STAGE_CEILING_TICKS = [MAX_CHECK_DELAY_TICKS, 3, 2];

export function checkDelayMs(input: { cfg: Config; account: string | null; now: number; decision: SwapDecision }): number {
  const { cfg, account, now, decision } = input;
  const tick = cfg.policy.checkIntervalMs;
  const max = maxCheckDelayMs(cfg);
  if (decision.waitUntil !== undefined) return Math.min(max, Math.max(tick, decision.waitUntil - now));
  const swapAt = loadLastSwapAt();
  if (swapAt != null && now - swapAt < POST_SWAP_COOLDOWN_MS) return swapAt + POST_SWAP_COOLDOWN_MS - now;
  const snap = loadUsageSnapshot();
  if (!account || !snap || !usageFresh(snap.state, snap.at, account, cfg.policy.usagePollTtlMs, now)) return 3 * tick;
  const accounts = loadAccounts().accounts;
  const u = freshest(snap.state, snap.at, accounts.find((a) => a.accountUuid === account)) ?? { ...snap.state, ts: snap.at };
  const mu = loadModelUsage();
  const muSame = mu && mu.account === account ? mu : null;
  const families = gatedFamilies(u.model, cfg.policy.switchModels);
  const bars = effectiveBars(cfg, { accounts: overlayLive(accounts, u, muSame, account), now, switchFamilies: families });
  const heads = [
    bars.session - liveUsed({ window: u.fiveHour, windowMs: FIVE_HOURS_MS, sampledAt: u.ts, now }),
    bars.weekly - liveUsed({ window: u.sevenDay, windowMs: WEEK_MS, sampledAt: u.ts, now }),
  ];
  let capMissing = false;
  const capFresh = muSame != null && now - (muSame.sampledAt ?? muSame.ts) <= cfg.policy.usagePollTtlMs;
  for (const family of families) {
    const cap = muSame && capFresh ? capForFamily(muSame, family, now) : undefined;
    if (cap && muSame) heads.push(bars.weekly - liveUsed({ window: cap, windowMs: WEEK_MS, sampledAt: muSame.sampledAt ?? muSame.ts, now }));
    else capMissing = true;
  }
  const headroom = Math.min(...heads);
  const banded = headroom >= 40 ? max : headroom >= 20 ? 3 * tick : headroom >= 8 ? 2 * tick : tick;
  const stage = sessionLadder(cfg).indexOf(bars.session);
  const staged = Math.min(banded, (STAGE_CEILING_TICKS[stage] ?? 1) * tick);
  return capMissing ? Math.min(staged, 2 * tick) : staged;
}
