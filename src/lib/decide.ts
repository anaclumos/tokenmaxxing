// Shared switch decision used by both the Stop hook and the SessionStart hook.
// Cheap pre-check off the lock; the authoritative re-check + swap under the flock.
//
// Two limit families are checked, both metered against the CURRENTLY-active org:
//   1. AGGREGATE windows (session=five_hour, week-all=seven_day) from statusLine.
//   2. PER-MODEL weekly cap (e.g. "week (Fable)") - only when the active model is
//      capacity-constrained (config policy.switchModels). This isn't in statusLine,
//      so we read it from `claude -p '/usage'`, TTL-cached (not every turn).
//
// The org guard is load-bearing: right after a respawn, usage.json still reflects
// the OLD account, so org != activeOrg → we correctly do nothing until fresh usage
// for the new account arrives.

import { maxBy } from "es-toolkit";
import { z } from "zod";
import { withLock } from "./lock.ts";
import { paths } from "./paths.ts";
import { loadAccounts, loadConfig, loadUsage, loadModelUsage, saveAccounts, saveModelUsage, writeUsage } from "./state.ts";
import { readOAuthAccount } from "./claudejson.ts";
import { chooseAndSwap, performSwap } from "./swap.ts";
import { pickEarliestReset, usableAt } from "./picker.ts";
import { InvalidGrantError } from "./oauth.ts";
import { familyTokens, matchedFamily, probeUsage } from "./usage.ts";
import { log } from "./log.ts";
import { AccountSchema, type Account, type Config, type ModelUsageState, type UsageState, type UsageWindow } from "./types.ts";

const SwapDecisionSchema = z.object({
  swapped: z.boolean(),
  account: AccountSchema.nullable(),
  reason: z.string(),
  /** set when every account is depleted: epoch ms the chosen account recovers. */
  waitUntil: z.number().optional(),
});
export type SwapDecision = z.infer<typeof SwapDecisionSchema>;

/** Cold-start aggregate fallback when statusLine hasn't written usage.json yet. */
async function probeAggregate(org: string | null): Promise<UsageState | null> {
  const full = await probeUsage();
  if (!full) return null;
  return { fiveHour: full.session, sevenDay: full.weekAll, org, ts: Date.now(), model: null };
}

/** Ensure a fresh-enough per-model cache for the active org; poll `/usage` if stale. */
async function ensurePerModel(cfg: Config, org: string | null): Promise<ModelUsageState | null> {
  const cached = loadModelUsage();
  const fresh = cached && cached.org === org && Date.now() - cached.ts < cfg.policy.usagePollTtlMs;
  if (fresh) return cached;
  const full = await probeUsage();
  if (!full) {
    // Probing the live token fail-silently while it's busy is expected; stamp the
    // cache so the next probe waits out the TTL instead of every turn re-paying
    // the full backoff (the 2026-07-10 post-swap probe storm).
    saveModelUsage({ perModel: cached?.org === org ? cached.perModel : {}, org, ts: Date.now() });
    return cached;
  }
  const state: ModelUsageState = { perModel: full.perModel, org, ts: Date.now() };
  saveModelUsage(state);
  return state;
}

/** The family's weekly cap among the `/usage` rows; when several rows match the
 *  family, the most-used one wins (switching early beats metering a depleted cap). */
function capForFamily(mu: ModelUsageState, family: string): UsageWindow | undefined {
  const rows = Object.entries(mu.perModel)
    .filter(([k]) => familyTokens(k).includes(family))
    .map(([, w]) => w);
  return maxBy(rows, (w) => w.usedPercentage);
}

/** True if the active account is over the floor on ANY applicable limit. */
function isOver(u: UsageState | null, mu: ModelUsageState | null, org: string | null, cfg: Config, floor: number): boolean {
  if (!u || !org || u.org !== org) return false;
  if (u.fiveHour.usedPercentage >= floor || u.sevenDay.usedPercentage >= floor) return true;
  const family = matchedFamily(u.model, cfg.policy.switchModels);
  if (family && mu && mu.org === org) {
    const cap = capForFamily(mu, family);
    if (cap && cap.usedPercentage >= floor) return true;
  }
  return false;
}

/** Does the active model warrant a per-model `/usage` poll? */
function needsPerModel(u: UsageState | null, cfg: Config): boolean {
  return matchedFamily(u?.model ?? null, cfg.policy.switchModels) !== null;
}

export async function evaluateAndMaybeSwap(now = Date.now()): Promise<SwapDecision> {
  const cfg = loadConfig();
  const floor = cfg.threshold - cfg.policy.projectionMargin;
  const activeOrg = readOAuthAccount()?.organizationUuid ?? null;

  let usage = loadUsage();
  if (!usage && activeOrg) {
    usage = await probeAggregate(activeOrg);
    // Persist: post-swap the snapshots are cleared and the statusLine tee is in
    // its grace window, so without this every turn boundary would re-probe.
    if (usage) writeUsage(usage);
  }

  // per-model poll (TTL-cached) only when on a capacity-constrained model
  const mu = needsPerModel(usage, cfg) ? await ensurePerModel(cfg, activeOrg) : null;

  // cheap pre-check off the lock - the common case exits here.
  if (!isOver(usage, mu, activeOrg, cfg, floor)) {
    return { swapped: false, account: null, reason: "under-threshold-or-stale" };
  }

  return withLock(paths.lockFile, async () => {
    const idx = loadAccounts();
    const org2 = readOAuthAccount()?.organizationUuid ?? null;
    const u2 = loadUsage() ?? usage;
    const mu2 = needsPerModel(u2, cfg) ? loadModelUsage() ?? mu : null;

    // record the active account's aggregate usage so the picker + `status` see it.
    if (u2 && org2 && u2.org === org2) {
      const active = idx.accounts.find((a) => a.accountUuid === idx.activeAccountUuid);
      if (active) {
        active.lastUsage = { fiveHour: u2.fiveHour, sevenDay: u2.sevenDay };
        // Snapshot per-model caps too, so they still show after we switch away.
        if (mu2 && mu2.org === org2) active.lastPerModel = mu2.perModel;
        saveAccounts(idx);
      }
    }

    if (!isOver(u2, mu2, org2, cfg, floor)) {
      return { swapped: false, account: null, reason: "raced-already-swapped" };
    }

    const landed = await chooseAndSwap({ now, threshold: cfg.threshold });
    if (landed) return { swapped: true, account: landed, reason: "swapped" };

    // Every account is depleted. Wait for whichever recovers soonest (including the
    // current one), if that reset is within the auto-wait window.
    const fresh = loadAccounts();
    const ctx = { now, threshold: cfg.threshold, currentAccountUuid: fresh.activeAccountUuid };
    const current = fresh.accounts.find((a) => a.accountUuid === fresh.activeAccountUuid);
    const currentAt = current ? usableAt(current, cfg.threshold, now) : Number.POSITIVE_INFINITY;
    const other = pickEarliestReset(fresh.accounts, ctx);

    let target: Account | null = null;
    let waitUntil = Number.POSITIVE_INFINITY;
    if (other && other.availableAt < currentAt) { target = other.account; waitUntil = other.availableAt; }
    else if (current) { target = current; waitUntil = currentAt; }
    else if (other) { target = other.account; waitUntil = other.availableAt; }

    if (!target || waitUntil - now > cfg.policy.maxWaitMs) {
      log("decide.depleted", { waitUntil: Number.isFinite(waitUntil) ? waitUntil : 0 });
      return { swapped: false, account: null, reason: "all-depleted" };
    }

    const isCurrent = target.accountUuid === fresh.activeAccountUuid;
    if (!isCurrent) {
      try {
        await performSwap(target);
      } catch (e) {
        if (e instanceof InvalidGrantError) return { swapped: false, account: null, reason: "all-depleted" };
        throw e;
      }
    }
    log("decide.depleted_wait", { account: target.accountUuid.slice(0, 8), waitUntil });
    return { swapped: !isCurrent, account: target, reason: "depleted-wait", waitUntil };
  });
}
