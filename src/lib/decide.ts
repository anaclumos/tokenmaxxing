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
import { loadAccounts, loadConfig, loadDepletedWait, loadLastSwapAt, loadUsage, loadModelUsage, saveAccounts, saveDepletedWait, saveModelUsage, usageTeeAt, writeUsage } from "./state.ts";
import { readOAuthAccount } from "./claudejson.ts";
import { chooseAndSwap, performSwap } from "./swap.ts";
import { currentWins, effectiveBars, hardBars, isExhausted, pickBest, pickEarliestReset, usableAt } from "./picker.ts";
import { InvalidGrantError } from "./oauth.ts";
import { familyTokens, gatedFamilies, probeUsage } from "./usage.ts";
import { log } from "./log.ts";
import { AccountSchema, ModelUsageStateSchema, UsageStateSchema, type Account, type Config, type ModelUsageState, type UsageState, type UsageWindow } from "./types.ts";

const SwapDecisionSchema = z.object({
  swapped: z.boolean(),
  account: AccountSchema.nullable(),
  reason: z.string(),
  /** set when every account is depleted and the soonest recovery is known:
   *  epoch ms that account recovers. The wait target on depleted-wait;
   *  informational on a bare all-depleted (callers like `xx serve` park on
   *  it - nothing here waits). */
  waitUntil: z.number().optional(),
});
export type SwapDecision = z.infer<typeof SwapDecisionSchema>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** A window's usable-against percentage NOW: one whose cached reset has passed
 *  is empty again, never a switch reason. A NULL-reset window (reset clock
 *  failed to parse) self-bounds at sampledAt + the window's own duration,
 *  mirroring the picker's blockedUntil and the codex liveUsed: without the
 *  bound the trigger side kept reading a long-stale over-bar row as live while
 *  the screening side had already released it - the two halves of one decision
 *  disagreed, forcing hard-path swaps (or waitUntil=now respawn churn) off a
 *  healthy account (adversarial-review catch). */
function liveUsed(input: { window: UsageWindow; windowMs: number; sampledAt: number; now: number }): number {
  const { window: w, windowMs, sampledAt, now } = input;
  if (w.resetsAt != null) return w.resetsAt <= now ? 0 : w.usedPercentage;
  if (now >= sampledAt + windowMs) return 0;
  return w.usedPercentage;
}

/** The family's weekly cap among the `/usage` rows; when several rows match the
 *  family, the most-used LIVE one wins (switching early beats metering a depleted
 *  cap, but a row whose reset passed must not mask a still-burning sibling). */
function capForFamily(mu: ModelUsageState, family: string, now: number): UsageWindow | undefined {
  const rows = Object.entries(mu.perModel)
    .filter(([k]) => familyTokens(k).includes(family))
    .map(([, w]) => w);
  return maxBy(rows, (w) => liveUsed({ window: w, windowMs: WEEK_MS, sampledAt: mu.sampledAt ?? mu.ts, now }));
}

/** True if the active account is over its floor on ANY screening bar: the 5h
 *  session against thresholds.session, the 7-day aggregate and gated per-model
 *  caps against thresholds.weekly. Over a bar means the hard path (swap away
 *  or depleted-wait); the greedy path may fire well before this. */
function isOver(u: UsageState | null, mu: ModelUsageState | null, org: string | null, cfg: Config, now: number): boolean {
  if (!u || !org || u.org !== org) return false;
  const bars = effectiveBars(cfg);
  if (
    liveUsed({ window: u.fiveHour, windowMs: FIVE_HOURS_MS, sampledAt: u.ts, now }) >= bars.session ||
    liveUsed({ window: u.sevenDay, windowMs: WEEK_MS, sampledAt: u.ts, now }) >= bars.weekly
  ) return true;
  if (mu && mu.org === org) {
    for (const family of gatedFamilies(u.model, cfg.policy.switchModels)) {
      const cap = capForFamily(mu, family, now);
      if (cap && liveUsed({ window: cap, windowMs: WEEK_MS, sampledAt: mu.sampledAt ?? mu.ts, now }) >= bars.weekly) return true;
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
  return liveUsed({ window: u.fiveHour, windowMs: FIVE_HOURS_MS, sampledAt: u.ts, now }) >= cfg.policy.greedySessionFloor || isOver(u, mu, org, cfg, now);
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
 * org-mismatched values forever - the 2026-07-12 ARM-box blindness. The
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
        mu = { perModel: full.perModel, org, ts, sampledAt: ts };
        saveModelUsage(mu);
      } else {
        // the anti-storm stamp: ts=now suppresses re-probing, but the carried
        // rows keep their ORIGINAL sample time - dating them by ts rolled the
        // null-reset self-bound forward on every failed probe (closing-review
        // catch).
        mu = { perModel: mu?.org === org ? (mu?.perModel ?? {}) : {}, org, ts, sampledAt: mu?.org === org ? (mu?.sampledAt ?? mu?.ts) : undefined };
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
export const POST_SWAP_COOLDOWN_MS = 45_000;

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
    return depletedReplay(now) ?? { swapped: false, account: null, reason: "post-swap-cooldown" };
  }

  const cfg = loadConfig();
  const activeOrg = readOAuthAccount()?.organizationUuid ?? null;

  const { u: usage, mu } = await loadFreshSnapshots(cfg, activeOrg, now);

  // cheap pre-check off the lock - the common case exits here. When there is
  // NO measurement for the live org (a pre-park just cleared the snapshots),
  // a recorded depleted-wait still replays; a fresh measurement that reads
  // under-threshold never does - measured-healthy must win over a stale wait.
  if (!isEngaged(usage, mu, activeOrg, cfg, now)) {
    const measured = usage != null && activeOrg != null && usage.org === activeOrg;
    if (!measured) {
      const replay = depletedReplay(now);
      if (replay) return replay;
    }
    return { swapped: false, account: null, reason: "under-threshold-or-stale" };
  }

  return withLock(paths.lockFile, async () => {
    const idx = loadAccounts();
    const org2 = readOAuthAccount()?.organizationUuid ?? null;
    const u2 = loadUsage() ?? usage;
    const mu2 = needsPerModel(u2, cfg) ? loadModelUsage() ?? mu : null;

    // A live login whose org is KNOWN but outside the pool: do nothing - the
    // codex org-guard analog. performSwap would refuse any swap over it (an
    // unpooled credential's only copy must never be overwritten), and the
    // seat fallback below must not stand in a stale pooled label for it: the
    // depleted path could then park a supervised session against the LABELED
    // account's reset while the running login is someone else entirely
    // (pullfrog review catch, PR #33).
    if (org2 != null && !idx.accounts.some((a) => a.organizationUuid === org2)) {
      return { swapped: false, account: null, reason: "live-credential-not-in-pool" };
    }

    // record the active account's aggregate usage so the picker + `status` see it.
    // Resolved by the LIVE org the guard just verified, never the
    // activeAccountUuid label: after a manual /login the label drifts (the
    // surviving drift source, see cli/switch.ts), and a label-keyed write
    // would stamp the live account's windows onto whichever account the label
    // still names (closing-review catch, mirrors the codex live-identity rule).
    if (u2 && org2 && u2.org === org2) {
      const active = idx.accounts.find((a) => a.organizationUuid === org2);
      if (active) {
        active.lastUsage = { fiveHour: u2.fiveHour, sevenDay: u2.sevenDay };
        active.lastUsageAt = u2.ts;
        // Snapshot per-model caps too, so they still show after we switch away.
        // An empty map is a failed probe's anti-storm stamp, not a measurement -
        // it must not erase the burnt-cap snapshot the picker screens on.
        if (mu2 && mu2.org === org2 && Object.keys(mu2.perModel).length > 0) {
          active.lastPerModel = mu2.perModel;
          // the rows' TRUE sample time, not the write time: an anti-storm
          // stamp re-writes ts while carrying old rows (closing-review catch).
          active.lastPerModelAt = mu2.sampledAt ?? mu2.ts;
        }
        saveAccounts(idx);
      }
    }

    if (!isEngaged(u2, mu2, org2, cfg, now)) {
      return depletedReplay(now) ?? { swapped: false, account: null, reason: "raced-already-swapped" };
    }

    // The SEAT every path below evaluates and excludes: the live org's pooled
    // account when resolvable, the stored label only as fallback - the same
    // identity rule as the usage stamp above and depletedReplay. Trusting the
    // label here let the greedy convergence judge a stale account as "the
    // seat" after a manual /login, ranking against the wrong cached windows
    // and even offering the LIVE account as a swap target (bugbot review
    // catch, PR #33).
    const seatOf = (idx2: { activeAccountUuid: string | null; accounts: Account[] }): Account | null =>
      idx2.accounts.find((a) => a.organizationUuid === org2) ??
      idx2.accounts.find((a) => a.accountUuid === idx2.activeAccountUuid) ??
      null;

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
        const active = seatOf(cur);
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
    }

    const landed = await chooseAndSwap({ now, thresholds: effectiveBars(cfg), switchFamilies, currentAccountUuid: seatOf(loadAccounts())?.accountUuid ?? null });
    if (landed) return { swapped: true, account: landed, reason: "swapped" };

    // ── LAYER 2 (the wall). Every account is exhausted at the Layer 1
    // screening bars, so Layer 1 alone would park the pool right here with
    // quota still unspent on every account. Before parking, pump the last drops
    // against the hard wall bars (default the server's own 100% limit, the same
    // figure /rate-limit-options reads): hold the seat while it is still under
    // its wall, else move onto the best still-under-wall account (chooseAndSwap
    // keeps the usual pace-pressure ranking - squeeze the account whose weekly
    // quota is most about to be forfeited first). Only when EVERY account has
    // truly walled do we fall through to the depleted-wait park below. The wall
    // reading is the statusLine's authoritative rate_limits tee (the same data
    // /rate-limit-options renders); a single-turn overshoot is caught one
    // boundary later by the check timer or the next Stop hook, and the serve/SDK
    // path additionally stamps observed limits on errored results.
    const hardCtx = { now, thresholds: hardBars(cfg), currentAccountUuid: null, switchFamilies };
    const seat = seatOf(loadAccounts());
    if (seat && !seat.needsReauth && !isExhausted(seat, hardCtx)) {
      log("decide.last_drop_hold", { account: seat.accountUuid.slice(0, 8) });
      return { swapped: false, account: null, reason: "last-drop-hold" };
    }
    const squeezed = await chooseAndSwap({ ...hardCtx, currentAccountUuid: seat?.accountUuid ?? null });
    if (squeezed) {
      log("decide.last_drop_swap", { account: squeezed.accountUuid.slice(0, 8) });
      return { swapped: true, account: squeezed, reason: "last-drop-swap" };
    }

    // Every account is walled. Wait for whichever drops below its wall soonest
    // (including the current one), if that reset is within the auto-wait window.
    // Recovery is measured against the WALL, not the screening bars: an account
    // whose session window resets below 100 is squeezable again even while its
    // weekly window still sits above the Layer 1 bar, so waiting on the Layer 1
    // reset would over-park. A dead grant on the chosen pre-park target must not
    // abort the wait: performSwap persists needs-reauth before throwing, so each
    // retry re-ranks without the dead account and the loop terminates (mirrors
    // the greedy loop above).
    while (true) {
      const fresh = loadAccounts();
      const current = seatOf(fresh);
      const ctx = { now, thresholds: hardBars(cfg), currentAccountUuid: current?.accountUuid ?? null, switchFamilies };
      const currentAt = current ? usableAt(current, ctx) : Number.POSITIVE_INFINITY;
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
          if (e instanceof InvalidGrantError) continue; // dead grant - re-rank without it
          throw e;
        }
      }
      // Persist the wait so sibling hooks arriving through the cooldown / raced
      // / cleared-snapshot exits replay it and write their OWN respawn markers.
      saveDepletedWait({ waitUntil, accountUuid: target.accountUuid, ts: now });
      log("decide.depleted_wait", { account: target.accountUuid.slice(0, 8), waitUntil });
      return { swapped: !isCurrent, account: target, reason: "depleted-wait", waitUntil };
    }
  });
}

/** The recorded depleted-wait, iff still standing: unexpired and still naming
 *  the LIVE seat. The check reads claude's own oauthAccount, not the
 *  accounts.json label: a tokenmaxxing swap rewrites oauthAccount inside its
 *  critical section and a manual /login rewrites it too, while the label lags
 *  a manual /login and would replay a wait for an account no longer live
 *  (review catch, PR #31). A real swap elsewhere, a manual /login, or the
 *  reset passing all kill the record. */
function depletedReplay(now: number): SwapDecision | null {
  const rec = loadDepletedWait();
  if (!rec || rec.waitUntil <= now) return null;
  const account = loadAccounts().accounts.find((a) => a.accountUuid === rec.accountUuid) ?? null;
  if (!account) return null;
  if (account.organizationUuid !== (readOAuthAccount()?.organizationUuid ?? null)) return null;
  return { swapped: false, account, reason: "depleted-wait", waitUntil: rec.waitUntil };
}
