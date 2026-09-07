import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "./lock.ts";
import { writeFileAtomic } from "./atomic.ts";
import { errorMessage } from "./errors.ts";
import { codexPaths } from "./paths.ts";
import { loadConfig, POST_SWAP_COOLDOWN_MS } from "./state.ts";
import { loadCodexAccounts, loadCodexLastSwapAt, saveCodexAccounts } from "./codexstate.ts";
import { codexCurrentWins, isCodexEngaged, isCodexExhausted, pickBestCodex } from "./codexpick.ts";
import { performCodexSwap } from "./codexswap.ts";
import { CodexInvalidGrantError, refreshCodexAuth } from "./codexoauth.ts";
import { fetchCodexUsage } from "./codexusage.ts";
import { codexIdentityOf, isCodexAccessExpiring, readLiveCodexAuth, writeLiveCodexAuth, writeParkedCodexAuth } from "./codexauth.ts";
import { liveCodexAccountId } from "./codexsample.ts";
import { livingCodexPresences, presentCodexAccountIds, targetableCodexAccounts } from "./codexpresence.ts";
import { terminalBars } from "./picker.ts";
import { log } from "./log.ts";
import type { CodexAccount, CodexReconcileMarker, Thresholds } from "./types.ts";

export type CodexSwapDecision = {
  swapped: boolean;
  account: CodexAccount | null;
  reason: string;
};

async function sampleLiveOntoOwner(input: { now: number }): Promise<string | null> {
  const { now } = input;
  let live = readLiveCodexAuth();
  if (!live) return null;
  const index = loadCodexAccounts();
  const identity = codexIdentityOf({ auth: live });
  const owner = index.accounts.find((account) => account.accountId === identity.accountId);
  if (!owner) return null;

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

function reconcileNonLiveSiblings(input: {
  index: { accounts: CodexAccount[] };
  liveAccountId: string;
  bars: Thresholds;
  now: number;
}): void {
  const { index, liveAccountId, bars, now } = input;
  const unusable = (account: CodexAccount): boolean =>
    account.needsReauth === true || isCodexExhausted({ account, thresholds: bars, now });
  const liveAccount = index.accounts.find((account) => account.accountId === liveAccountId);
  if (!liveAccount || unusable(liveAccount)) return;
  const living = livingCodexPresences();
  if (existsSync(codexPaths.reconcileDir)) {
    const alive = new Set(living.map((presence) => presence.supervisorId));
    for (const name of readdirSync(codexPaths.reconcileDir)) {
      if (!alive.has(name)) rmSync(join(codexPaths.reconcileDir, name), { force: true });
    }
  }
  for (const presence of living) {
    if (presence.accountId === liveAccountId) continue;
    const seated = index.accounts.find((account) => account.accountId === presence.accountId);
    if (!seated) continue;
    const markerPath = join(codexPaths.reconcileDir, presence.supervisorId);
    if (existsSync(markerPath)) continue;
    mkdirSync(codexPaths.reconcileDir, { recursive: true });
    const marker: CodexReconcileMarker = { accountId: presence.accountId, ts: now };
    writeFileAtomic(markerPath, JSON.stringify(marker));
    log("codexdecide.reconcile_signal", { supervisorId: presence.supervisorId.slice(0, 8), account: presence.accountId.slice(0, 8) });
  }
}

function postSwapResweep(input: { liveAccountId: string; bars: Thresholds; now: number }): void {
  try {
    reconcileNonLiveSiblings({ index: loadCodexAccounts(), liveAccountId: input.liveAccountId, bars: input.bars, now: input.now });
  } catch (e) {
    log("codexdecide.resweep_failed", { err: errorMessage(e) });
  }
}

export async function evaluateAndMaybeSwapCodex(input: { now?: number }): Promise<CodexSwapDecision> {
  const now = input.now ?? Date.now();
  const cfg = loadConfig();
  const bars = terminalBars(cfg);

  return withLock(codexPaths.lockFile, async () => {
    let index = loadCodexAccounts();
    if (index.accounts.length === 0) return { swapped: false, account: null, reason: "no-pool" };

    const activeId = liveCodexAccountId();
    if (activeId == null || !index.accounts.some((account) => account.accountId === activeId)) {
      return { swapped: false, account: null, reason: "live-credential-not-in-pool" };
    }

    reconcileNonLiveSiblings({ index, liveAccountId: activeId, bars, now });

    const lastSwapAt = loadCodexLastSwapAt();
    if (lastSwapAt != null && now - lastSwapAt < POST_SWAP_COOLDOWN_MS) {
      return { swapped: false, account: null, reason: "post-swap-cooldown" };
    }

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

    const engaged =
      active.needsReauth === true ||
      isCodexEngaged({ account: active, floor: cfg.policy.greedySessionFloor, now }) ||
      isCodexExhausted({ account: active, thresholds: bars, now });
    if (!engaged) return { swapped: false, account: null, reason: "under-threshold-or-stale" };

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
        postSwapResweep({ liveAccountId: best.accountId, bars, now });
        return { swapped: true, account: best, reason: "swapped" };
      }
    }

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
      postSwapResweep({ liveAccountId: best.accountId, bars, now });
      return { swapped: true, account: best, reason: "swapped" };
    }
  });
}
