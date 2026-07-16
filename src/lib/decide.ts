// Shared switch decision used by the Stop/SessionStart hooks and the periodic
// `check` timer. Cheap pre-check off the lock; the authoritative re-check + swap
// under the flock.
//
// The decision ENGAGES (user policy 2026-07-16) once the active account's 5h
// session window reaches policy.greedySessionFloor, or once any screening bar
// is crossed. Engaged-but-under-every-bar runs the same greedy pace-pressure
// convergence as bare `xx switch` (swap only onto a STRICTLY better usable
// account, current keeps its seat on ties, never a depleted pre-park); over a
// bar keeps the original hard semantics (swap or depleted-wait).
//
// The windows feeding that, all metered against the CURRENTLY-active org:
//   1. AGGREGATE windows (session=five_hour, week-all=seven_day). A rendering
//      statusLine tees them fresh every turn; when nothing renders (headless
//      boxes, idle TUIs) they come from `claude -p '/usage'`, re-probed once the
//      snapshot ages past the poll TTL so they can never freeze at a stale value.
//   2. PER-MODEL weekly cap (e.g. "week (Fable)") - when the active model is
//      capacity-constrained (config policy.switchModels), or for EVERY configured
//      family when the model is unknown (nothing rendered within the TTL, so the
//      session that stamped the last model may be gone).
//
// The org guard is load-bearing: right after a respawn, usage.json still reflects
// the OLD account, so org != activeOrg → we correctly do nothing until fresh usage
// for the new account arrives.

import { maxBy } from "es-toolkit";
import { z } from "zod";
import { withLock } from "./lock.ts";
import { paths } from "./paths.ts";
import { loadAccounts, loadConfig, loadLastSwapAt, loadUsage, loadModelUsage, saveAccounts, saveModelUsage, usageTeeAt, writeUsage } from "./state.ts";
import { readOAuthAccount } from "./claudejson.ts";
import { chooseAndSwap, performSwap } from "./swap.ts";
import { currentWins, effectiveBars, pickBest, pickEarliestReset, usableAt } from "./picker.ts";
import { InvalidGrantError } from "./oauth.ts";
import { familyTokens, gatedFamilies, probeUsage } from "./usage.ts";
import { log } from "./log.ts";
import { AccountSchema, ModelUsageStateSchema, UsageStateSchema, type Account, type Config, type ModelUsageState, type UsageState, type UsageWindow } from "./types.ts";

const SwapDecisionSchema = z.object({
  swapped: z.boolean(),
  account: AccountSchema.nullable(),
  reason: z.string(),
  /** set when every account is depleted: epoch ms the chosen account recovers. */
  waitUntil: z.number().optional(),
});
export type SwapDecision = z.infer<typeof SwapDecisionSchema>;

/** A window's usable-against percentage NOW: one whose cached reset has passed
 *  is empty again, never a switch reason. */
function liveUsed(w: UsageWindow, now: number): number {
  return w.resetsAt != null && w.resetsAt <= now ? 0 : w.usedPercentage;
}

/** The family's weekly cap among the `/usage` rows; when several rows match the
 *  family, the most-used LIVE one wins (switching early beats metering a depleted
 *  cap, but a row whose reset passed must not mask a still-burning sibling). */
function capForFamily(mu: ModelUsageState, family: string, now: number): UsageWindow | undefined {
  const rows = Object.entries(mu.perModel)
    .filter(([k]) => familyTokens(k).includes(family))
    .map(([, w]) => w);
  return maxBy(rows, (w) => liveUsed(w, now));
}

/** True if the active account is over its floor on ANY screening bar: the 5h
 *  session against thresholds.session, the 7-day aggregate and gated per-model
 *  caps against thresholds.weekly. Over a bar means the hard path (swap away
 *  or depleted-wait); the greedy path may fire well before this. */
function isOver(u: UsageState | null, mu: ModelUsageState | null, org: string | null, cfg: Config, now: number): boolean {
  if (!u || !org || u.org !== org) return false;
  const bars = effectiveBars(cfg);
  if (liveUsed(u.fiveHour, now) >= bars.session || liveUsed(u.sevenDay, now) >= bars.weekly) return true;
  if (mu && mu.org === org) {
    for (const family of gatedFamilies(u.model, cfg.policy.switchModels)) {
      const cap = capForFamily(mu, family, now);
      if (cap && liveUsed(cap, now) >= bars.weekly) return true;
    }
  }
  return false;
}

/** Does a per-model cap gate the decision for this usage snapshot? */
function needsPerModel(u: UsageState | null, cfg: Config): boolean {
  return u != null && gatedFamilies(u.model, cfg.policy.switchModels).length > 0;
}

/** Whether the decision engages at all: half a session window buys the swap
 *  (greedySessionFloor), and a crossed screening bar always does. Below both,
 *  a fresh session rides its account - no churn. */
function isEngaged(u: UsageState | null, mu: ModelUsageState | null, org: string | null, cfg: Config, now: number): boolean {
  if (!u || !org || u.org !== org) return false;
  return liveUsed(u.fiveHour, now) >= cfg.policy.greedySessionFloor || isOver(u, mu, org, cfg, now);
}

const SnapshotsSchema = z.object({
  u: UsageStateSchema.nullable(),
  mu: ModelUsageStateSchema.nullable(),
});
type Snapshots = z.infer<typeof SnapshotsSchema>;

/** usage.json is trusted while the tee proved itself alive (mtime, NOT the
 *  embedded ts - write-on-change lets ts age under an alive feed) within the
 *  TTL for the live org. */
function usageFresh(u: UsageState | null, org: string | null, ttl: number, now: number): boolean {
  if (u == null || u.org !== org) return false;
  const teeAt = usageTeeAt();
  return teeAt != null && now - teeAt <= ttl;
}

/**
 * Load the two usage snapshots, re-probing `/usage` (free, 0 tokens) when they
 * are absent, org-drifted, or older than the poll TTL. ONE probe carries all
 * three limit kinds, so a success refreshes BOTH files; anything less leaves a
 * headless box (no rendering statusLine to tee) evaluating frozen or
 * org-mismatched values forever - the 2026-07-12 stella blindness. The
 * refreshed usage carries model: null (whatever session stamped the old model
 * may be gone), which gates every configured family. model-usage.json's ts also
 * stamps FAILED attempts, so a busy live token cannot cause a probe storm
 * (2026-07-10): the next hook waits out the TTL instead of re-probing.
 */
async function loadFreshSnapshots(cfg: Config, org: string | null, now: number): Promise<Snapshots> {
  let u = loadUsage();
  let mu = loadModelUsage();
  const ttl = cfg.policy.usagePollTtlMs;
  const probeAttempted = mu != null && mu.org === org && now - mu.ts <= ttl;
  if (org && !probeAttempted && (!usageFresh(u, org, ttl, now) || needsPerModel(u, cfg))) {
    const full = await probeUsage();
    const ts = Date.now();
    // A swap can complete while the probe runs (no lock is held here). Its
    // result would then be stamped under the pre-swap org over the files the
    // swap just cleared - discard it; the locked re-check below rejects this
    // evaluation anyway and the next one re-probes the new org.
    if (readOAuthAccount()?.organizationUuid === org) {
      if (full) {
        // A probe takes seconds; a rendering session's tee may have landed
        // while it ran. The tee is fresher AND model-aware, so it wins.
        const teed = loadUsage();
        if (usageFresh(teed, org, ttl, ts)) {
          u = teed;
        } else {
          u = { fiveHour: full.session, sevenDay: full.weekAll, org, ts, model: null };
          writeUsage(u);
        }
        mu = { perModel: full.perModel, org, ts };
        saveModelUsage(mu);
      } else {
        mu = { perModel: mu?.org === org ? (mu?.perModel ?? {}) : {}, org, ts };
        saveModelUsage(mu);
      }
    }
  }
  return { u, mu };
}

/** How long after a swap the auto paths hold still. The statusLine tee is
 *  suppressed this long (sessions adopt the swap in <=30s), so a decision made
 *  sooner runs model-blind on data the swap itself invalidated - that is how a
 *  model-aware swap got immediately undone into an A<->B respawn loop. Manual
 *  `switch` is unaffected. */
const POST_SWAP_COOLDOWN_MS = 45_000;

/**
 * `anticipatory` allows the depleted path to swap onto an account that is still
 * blocked but recovers soonest. Only a caller that can PAUSE until the reset
 * (the supervised Stop hook, which writes a respawn marker the supervisor
 * honors with a countdown) should pass true: from the check timer or an
 * unsupervised hook, pre-parking silently yanks a live session onto a
 * known-over-limit account, and buys nothing - the normal pick path adopts the
 * recovering account the moment its reset passes.
 */
export async function evaluateAndMaybeSwap(now = Date.now(), anticipatory = false): Promise<SwapDecision> {
  const lastSwapAt = loadLastSwapAt();
  if (lastSwapAt != null && now - lastSwapAt < POST_SWAP_COOLDOWN_MS) {
    return { swapped: false, account: null, reason: "post-swap-cooldown" };
  }

  const cfg = loadConfig();
  const activeOrg = readOAuthAccount()?.organizationUuid ?? null;

  const { u: usage, mu } = await loadFreshSnapshots(cfg, activeOrg, now);

  // cheap pre-check off the lock - the common case exits here.
  if (!isEngaged(usage, mu, activeOrg, cfg, now)) {
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
        active.lastUsageAt = u2.ts;
        // Snapshot per-model caps too, so they still show after we switch away.
        // An empty map is a failed probe's anti-storm stamp, not a measurement -
        // it must not erase the burnt-cap snapshot the picker screens on.
        if (mu2 && mu2.org === org2 && Object.keys(mu2.perModel).length > 0) active.lastPerModel = mu2.perModel;
        saveAccounts(idx);
      }
    }

    if (!isEngaged(u2, mu2, org2, cfg, now)) {
      return { swapped: false, account: null, reason: "raced-already-swapped" };
    }

    // Candidates are screened by the same families that drove this decision, so
    // the pool cannot ping-pong onto an account the gate would immediately flag.
    const switchFamilies = gatedFamilies(u2?.model ?? null, cfg.policy.switchModels);

    // Greedy path: engaged but under every screening bar. Converge like bare
    // `xx switch` - swap only onto a strictly better usable account - and stay
    // put otherwise: with a usable current account, a depleted pre-park or wait
    // would trade a working session for nothing. NOT chooseAndSwap: its dead-
    // token fallback lands on the next usable candidate unconditionally, but
    // here the fallback must ALSO strictly beat the current account, or a dead
    // refresh token on the winner would bounce a healthy session onto a worse
    // account and back. performSwap marks needs-reauth before throwing, so each
    // reload re-ranks without the dead account and the loop must terminate.
    if (!isOver(u2, mu2, org2, cfg, now)) {
      const ctxAll = { now, thresholds: effectiveBars(cfg), currentAccountUuid: null, switchFamilies };
      while (true) {
        const cur = loadAccounts();
        const active = cur.accounts.find((a) => a.accountUuid === cur.activeAccountUuid) ?? null;
        if (currentWins(active, cur.accounts, ctxAll)) {
          return { swapped: false, account: null, reason: "current-best" };
        }
        const best = pickBest(cur.accounts, { ...ctxAll, currentAccountUuid: cur.activeAccountUuid });
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
    }

    const landed = await chooseAndSwap({ now, thresholds: effectiveBars(cfg), switchFamilies });
    if (landed) return { swapped: true, account: landed, reason: "swapped" };

    // Every account is depleted. Wait for whichever recovers soonest (including the
    // current one), if that reset is within the auto-wait window.
    const fresh = loadAccounts();
    const ctx = { now, thresholds: effectiveBars(cfg), currentAccountUuid: fresh.activeAccountUuid, switchFamilies };
    const current = fresh.accounts.find((a) => a.accountUuid === fresh.activeAccountUuid);
    const currentAt = current ? usableAt(current, ctx) : Number.POSITIVE_INFINITY;
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
    if (!isCurrent && !anticipatory) {
      log("decide.depleted_no_park", { account: target.accountUuid.slice(0, 8), waitUntil });
      return { swapped: false, account: null, reason: "all-depleted" };
    }
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
