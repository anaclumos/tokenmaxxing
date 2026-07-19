// Shared codex switch decision, used by the codex Stop hook and `xx switch
// --codex`. Same policy as decide.ts, reshaped for codex mechanics: usage
// comes from the free direct GET (no statusLine tee exists), the greedy floor
// reads against every window class (current codex plans have no 5h window:
// the weekly aggregate is primary, verified live 2026-07-16), and there is no
// depleted pre-park (a swap only lands where a window is usable NOW; a
// depleted pool stays put and recovers when a cached reset passes).

import { z } from "zod";
import { withLock } from "./lock.ts";
import { codexPaths } from "./paths.ts";
import { loadConfig } from "./state.ts";
import { loadCodexAccounts, loadCodexLastSwapAt, saveCodexAccounts } from "./codexstate.ts";
import { codexCurrentWins, isCodexEngaged, isCodexExhausted, pickBestCodex } from "./codexpick.ts";
import { performCodexSwap } from "./codexswap.ts";
import { CodexInvalidGrantError, refreshCodexAuth } from "./codexoauth.ts";
import { fetchCodexUsage } from "./codexusage.ts";
import { codexIdentityOf, isCodexAccessExpiring, readLiveCodexAuth, writeLiveCodexAuth, writeParkedCodexAuth } from "./codexauth.ts";
import { liveCodexAccountId } from "./codexsample.ts";
import { targetableCodexAccounts } from "./codexpresence.ts";
import { effectiveBars } from "./picker.ts";
import { log } from "./log.ts";
import { CodexAccountSchema } from "./types.ts";

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
 * Refreshes the live blob first when it is near expiry, persisting the
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

  if (isCodexAccessExpiring({ auth: live, now })) {
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

export async function evaluateAndMaybeSwapCodex(input: { now?: number }): Promise<CodexSwapDecision> {
  const now = input.now ?? Date.now();
  const lastSwapAt = loadCodexLastSwapAt();
  if (lastSwapAt != null && now - lastSwapAt < POST_SWAP_COOLDOWN_MS) {
    return { swapped: false, account: null, reason: "post-swap-cooldown" };
  }

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
      return { swapped: true, account: best, reason: "swapped" };
    }
  });
}
