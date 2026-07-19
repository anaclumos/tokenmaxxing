// Shared codex switch decision, used by the codex Stop hook and `xx switch
// --codex`. Same policy as decide.ts, reshaped for codex mechanics: usage
// comes from the free direct GET (no statusLine tee exists), the greedy floor
// reads against every window class (current codex plans have no 5h window:
// the weekly aggregate is primary, verified live 2026-07-16), and there is no
// depleted pre-park (a swap only lands where a window is usable NOW; a
// depleted pool stays put and recovers when a cached reset passes).

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { withLock } from "./lock.ts";
import { writeFileAtomic } from "./atomic.ts";
import { codexPaths } from "./paths.ts";
import { loadConfig } from "./state.ts";
import { loadCodexAccounts, loadCodexLastSwapAt, saveCodexAccounts } from "./codexstate.ts";
import { codexCurrentWins, isCodexEngaged, isCodexExhausted, pickBestCodex } from "./codexpick.ts";
import { performCodexSwap } from "./codexswap.ts";
import { CodexInvalidGrantError, refreshCodexAuth } from "./codexoauth.ts";
import { fetchCodexUsage } from "./codexusage.ts";
import { codexIdentityOf, isCodexAccessExpiring, readLiveCodexAuth, writeLiveCodexAuth, writeParkedCodexAuth } from "./codexauth.ts";
import { liveCodexAccountId } from "./codexsample.ts";
import { livingCodexPresences, presentCodexAccountIds, targetableCodexAccounts } from "./codexpresence.ts";
import { effectiveBars } from "./picker.ts";
import { log } from "./log.ts";
import { CodexAccountSchema, CodexReconcileMarkerSchema, type CodexAccount } from "./types.ts";

const CodexSwapDecisionSchema = z.object({
  swapped: z.boolean(),
  account: CodexAccountSchema.nullable(),
  reason: z.string(),
});
export type CodexSwapDecision = z.infer<typeof CodexSwapDecisionSchema>;

const POST_SWAP_COOLDOWN_MS = 45_000;

/**
 * Sample the LIVE credential's usage and stamp it onto its TRUE owner in the
 * pool (the id_token's own identity: labels drift, the token cannot lie).
 * Refreshes the live blob first when it is near expiry (and no supervised
 * session is running it - see the presence guard below), persisting the
 * rotation to the live file AND the owner's parked copy in the same step -
 * before the usage fetch, so a failed fetch can never strand the parked copy
 * on the reuse-punished superseded refresh token. A dead live grant marks the
 * owner needs-reauth and keeps the cached snapshot, so the decision below can
 * still swap AWAY from it. Returns the owner id, or null when the live
 * credential is absent or unpooled.
 */
async function sampleLiveOntoOwner(input: { now: number }): Promise<string | null> {
  const { now } = input;
  let live = readLiveCodexAuth();
  if (!live) return null;
  const index = loadCodexAccounts();
  const identity = codexIdentityOf({ auth: live });
  const owner = index.accounts.find((account) => account.accountId === identity.accountId);
  if (!owner) return null;

  // The near-expiry refresh is skipped while any supervised session RUNS the
  // live account: a sibling's Stop hook (or the timer) can land mid-turn of
  // that session, and two concurrent POSTs of the same rotating refresh token
  // reuse-punish the loser into a dead grant family (closing-review catch).
  // The unrotated token stays valid within the margin, so the fetch below
  // still samples; once expired it fails loudly and the next cycle, after the
  // running session's own refresh, recovers.
  if (isCodexAccessExpiring({ auth: live, now }) && !presentCodexAccountIds().has(identity.accountId)) {
    try {
      live = await refreshCodexAuth({ auth: live, now });
    } catch (e) {
      if (e instanceof CodexInvalidGrantError) {
        owner.needsReauth = true;
        saveCodexAccounts({ index });
        log("codexdecide.live_invalid_grant", { account: owner.accountId.slice(0, 8) });
        return owner.accountId;
      }
      throw e;
    }
    writeLiveCodexAuth({ auth: live });
    writeParkedCodexAuth({ credFile: owner.credFile, auth: live });
  }
  const usage = await fetchCodexUsage({ auth: live });
  owner.lastUsage = { aggregate: usage.aggregate, perLimit: usage.perLimit };
  owner.lastUsageAt = now;
  if (usage.email != null) owner.email = usage.email;
  if (usage.planType != null) owner.planType = usage.planType;
  saveCodexAccounts({ index });
  return owner.accountId;
}

/**
 * OWNER-APPROVED sibling reconcile (2026-07-20, option b): codex cannot
 * hot-swap, so a pool swap respawns only the deciding session - siblings keep
 * running whatever account they started on, and once that account is
 * exhausted or its grant dies they have no automated escape (their own
 * decision evaluates only the live seat). The deciding actor therefore
 * SIGNALS each such supervisor cross-session: a reconcile marker addressed by
 * supervisorId (presence filenames carry it). The signal is a marker, never a
 * kill: the only safe respawn point is the sibling's own turn boundary, so
 * its Stop hook promotes the marker into a respawn marker there, adding the
 * session id its stdin alone knows. No respawn-cost margin applies - a dead
 * or exhausted seat is the hard-path class - and no signal is ever sent while
 * the LIVE seat is itself unusable (the no-depleted-pre-park analog: never
 * move a session onto a blocked account). Orphaned markers (their supervisor
 * exited before promoting) are garbage-collected here. Idempotent per
 * supervisor: an existing marker is left alone.
 *
 * There is deliberately NO self-exclusion (bugbot/pullfrog/cubic review
 * catches, PR #34): a session whose presence names a non-live account IS the
 * stranded sibling even inside its own hook - its "normal decision" evaluates
 * only the live seat and would never rescue it. A signal the sweep writes for
 * the calling session is consumed by the promote pass its own hook runs right
 * after the evaluation, same boundary. The deciding session that just swapped
 * away leaves a self-addressed signal behind too; the promote staleness guard
 * (presence rewritten at respawn) drops it as moot.
 */
function reconcileExhaustedSiblings(input: {
  index: { accounts: CodexAccount[] };
  liveAccountId: string;
  bars: { session: number; weekly: number };
  now: number;
}): void {
  const { index, liveAccountId, bars, now } = input;
  const unusable = (account: CodexAccount): boolean =>
    account.needsReauth === true || isCodexExhausted({ account, thresholds: bars, now });
  const liveAccount = index.accounts.find((account) => account.accountId === liveAccountId);
  if (!liveAccount || unusable(liveAccount)) return;
  const living = livingCodexPresences();
  // gc signals addressed to supervisors that no longer live (exited before
  // promoting): nothing would ever consume them.
  if (existsSync(codexPaths.reconcileDir)) {
    const alive = new Set(living.map((presence) => presence.supervisorId));
    for (const name of readdirSync(codexPaths.reconcileDir)) {
      if (!alive.has(name)) rmSync(join(codexPaths.reconcileDir, name), { force: true });
    }
  }
  for (const presence of living) {
    if (presence.accountId === liveAccountId) continue; // riding the live seat: fine
    const seated = index.accounts.find((account) => account.accountId === presence.accountId);
    // INTENTIONAL TRADEOFF, PENDING OWNER RULING (closing-review HIGH,
    // 2026-07-20): a sibling riding a departed-but-HEALTHY account is not
    // signaled, even though codex's guarded reload refuses a cross-account
    // auth.json refresh, so that session wedges with "Please sign in again"
    // once its in-memory access token expires (hours). The owner approved
    // respawning EXHAUSTED siblings only (option b, 2026-07-20); extending
    // forced respawns to healthy working sessions - or suppressing greedy
    // swaps while siblings ride the seat - is a policy widening the owner has
    // not made. Until ruled, healthy-but-non-live siblings are the documented
    // gap: they keep working on their current token and fail loudly at its
    // expiry.
    if (!seated || !unusable(seated)) continue; // unpooled or still healthy: not ours to move
    const markerPath = join(codexPaths.reconcileDir, presence.supervisorId);
    if (existsSync(markerPath)) continue;
    mkdirSync(codexPaths.reconcileDir, { recursive: true });
    writeFileAtomic(markerPath, JSON.stringify(CodexReconcileMarkerSchema.parse({ accountId: presence.accountId, ts: now })));
    log("codexdecide.reconcile_signal", { supervisorId: presence.supervisorId.slice(0, 8), account: presence.accountId.slice(0, 8) });
  }
}

/** The re-sweep after a PERSISTED swap: failures are logged, never thrown -
 *  the caller must still report swapped:true so the Stop hook writes the
 *  deciding session's own respawn marker. */
function postSwapResweep(input: { liveAccountId: string; bars: { session: number; weekly: number }; now: number }): void {
  try {
    reconcileExhaustedSiblings({ index: loadCodexAccounts(), liveAccountId: input.liveAccountId, bars: input.bars, now: input.now });
  } catch (e) {
    log("codexdecide.resweep_failed", { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function evaluateAndMaybeSwapCodex(input: { now?: number }): Promise<CodexSwapDecision> {
  const now = input.now ?? Date.now();
  const cfg = loadConfig();
  const bars = effectiveBars(cfg);

  return withLock(codexPaths.lockFile, async () => {
    let index = loadCodexAccounts();
    if (index.accounts.length === 0) return { swapped: false, account: null, reason: "no-pool" };

    // The current account is ALWAYS the live auth.json's own identity: the
    // stored activeAccountId label drifts (manual `codex login`, a crash
    // before saveCodexAccounts), and trusting it once let the decision target
    // the RUNNING account (adversarial review catch, 2026-07-16). A live
    // identity outside the pool is the org-guard analog: do nothing, a swap
    // over an unknown credential could destroy its only copy.
    const activeId = liveCodexAccountId();
    if (activeId == null || !index.accounts.some((account) => account.accountId === activeId)) {
      return { swapped: false, account: null, reason: "live-credential-not-in-pool" };
    }

    // Cross-session sibling reconcile runs on EVERY evaluation, BEFORE both
    // the cooldown return and the engagement gate: a swap strands siblings at
    // exactly the moment the cooldown starts (bugbot/cubic review catch,
    // PR #34), and a sibling can be dead while the live seat is healthy and
    // disengaged. Cached windows are enough here - the promote pass
    // revalidates both accounts' usability at consumption time.
    reconcileExhaustedSiblings({ index, liveAccountId: activeId, bars, now });

    const lastSwapAt = loadCodexLastSwapAt();
    if (lastSwapAt != null && now - lastSwapAt < POST_SWAP_COOLDOWN_MS) {
      return { swapped: false, account: null, reason: "post-swap-cooldown" };
    }

    // Freshness: re-sample the live credential once its owner's cached
    // snapshot ages past the poll TTL (there is no push feed in between).
    const activeEntry = index.accounts.find((account) => account.accountId === activeId);
    const stale = activeEntry?.lastUsageAt == null || now - activeEntry.lastUsageAt > cfg.policy.usagePollTtlMs;
    if (stale) {
      const sampledId = await sampleLiveOntoOwner({ now });
      if (sampledId == null) {
        return { swapped: false, account: null, reason: "live-credential-not-in-pool" };
      }
      index = loadCodexAccounts();
    }

    const active = index.accounts.find((account) => account.accountId === activeId) ?? null;
    if (!active) return { swapped: false, account: null, reason: "no-active-account" };

    // A dead live grant always engages: the seat is unusable regardless of
    // cached usage, and codexCurrentWins/pickBestCodex already exclude
    // needs-reauth accounts, so both branches route onto a healthy target.
    const engaged =
      active.needsReauth === true ||
      isCodexEngaged({ account: active, floor: cfg.policy.greedySessionFloor, now }) ||
      isCodexExhausted({ account: active, thresholds: bars, now });
    if (!engaged) return { swapped: false, account: null, reason: "under-threshold-or-stale" };

    // Greedy path: engaged but under every bar. Swap only onto an account
    // that beats the seat by the respawn-cost margin, never onto one RUNNING
    // in another session (presence files); re-rank after a dead grant
    // (performCodexSwap persists needs-reauth before throwing, so the loop
    // terminates).
    if (!isCodexExhausted({ account: active, thresholds: bars, now })) {
      while (true) {
        const current = loadCodexAccounts();
        const candidates = targetableCodexAccounts({ accounts: current.accounts, activeAccountId: activeId });
        const cur = candidates.find((account) => account.accountId === activeId) ?? null;
        if (codexCurrentWins({ active: cur, accounts: candidates, thresholds: bars, now })) {
          return { swapped: false, account: null, reason: "current-best" };
        }
        const best = pickBestCodex({ accounts: candidates, thresholds: bars, now, currentAccountId: activeId });
        if (!best) return { swapped: false, account: null, reason: "no-usable-target" };
        try {
          await performCodexSwap({ target: best });
        } catch (e) {
          if (e instanceof CodexInvalidGrantError) continue;
          throw e;
        }
        log("codexdecide.greedy_swap", { account: best.accountId.slice(0, 8) });
        // Re-sweep with the NEW live seat: siblings on the account this swap
        // just departed were invisible to the entry sweep (their account WAS
        // the live seat then), and the cooldown blocks the next evaluation's
        // sweep-entry for 45s (pullfrog review catch, PR #34). GUARDED: the
        // swap is already persisted, so a sweep failure (e.g. a corrupt
        // presence file, which livingCodexPresences throws on by design) must
        // not eat the swapped:true return - the Stop hook needs it to write
        // THIS session's respawn marker (bugbot/cubic P0 catch, PR #34). The
        // entry sweep stays fail-loud: there nothing irreversible has
        // happened yet.
        postSwapResweep({ liveAccountId: best.accountId, bars, now });
        return { swapped: true, account: best, reason: "swapped" };
      }
    }

    // Hard path: a bar is crossed. Land on the best usable candidate, walking
    // past dead grants; a fully depleted pool stays put (no pre-park: nothing
    // can pause a codex session for a countdown yet).
    const tried = new Set<string>();
    while (true) {
      const current = loadCodexAccounts();
      const candidates = targetableCodexAccounts({ accounts: current.accounts, activeAccountId: activeId }).filter(
        (account) => !tried.has(account.accountId),
      );
      const best = pickBestCodex({ accounts: candidates, thresholds: bars, now, currentAccountId: activeId });
      if (!best) return { swapped: false, account: null, reason: "all-depleted" };
      tried.add(best.accountId);
      try {
        await performCodexSwap({ target: best });
      } catch (e) {
        if (e instanceof CodexInvalidGrantError) continue;
        throw e;
      }
      log("codexdecide.hard_swap", { account: best.accountId.slice(0, 8) });
      // Same guarded post-swap re-sweep as the greedy branch: the departed
      // account's siblings become signalable only once it stops being the
      // live seat, and a sweep failure must not eat the swapped:true return.
      postSwapResweep({ liveAccountId: best.accountId, bars, now });
      return { swapped: true, account: best, reason: "swapped" };
    }
  });
}
