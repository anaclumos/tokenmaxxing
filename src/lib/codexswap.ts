// The codex account-switch sequence. Runs under tokenmaxxing's codex flock
// (held by the caller). Codex itself has NO cross-process lock on auth.json
// (verified rust-v0.144.5: refresh serialization is an in-process semaphore),
// so this flock only serializes tokenmaxxing actors; a RUNNING codex can still
// refresh-write the live file concurrently. The sequence therefore keeps the
// harvest-install window as short as possible, and the Stop-hook trigger fires
// only at an idle turn boundary where the running codex has just finished
// using (and refreshing, if needed) its token.
//
//   refresh target's parked blob (network, validates the grant, rotates)
//   harvest live auth.json verbatim under its OWN identity (labels drift,
//     the id_token cannot lie; an unknown live identity refuses the swap)
//   install the refreshed target as the whole live auth.json
//   persist the rotation into the target's parked blob
//   commit activeAccountId in the same critical section

import { codexIdentityOf, readLiveCodexAuth, readParkedCodexAuth, writeLiveCodexAuth, writeParkedCodexAuth } from "./codexauth.ts";
import { CodexInvalidGrantError, refreshCodexAuth } from "./codexoauth.ts";
import { loadCodexAccounts, saveCodexAccounts, saveCodexLastSwapAt } from "./codexstate.ts";
import { log } from "./log.ts";
import type { CodexAccount } from "./types.ts";

export async function performCodexSwap(input: { target: CodexAccount }): Promise<void> {
  const { target } = input;
  const index = loadCodexAccounts();

  const parked = readParkedCodexAuth({ credFile: target.credFile });
  if (!parked) throw new Error(`no parked codex credential for ${target.label}`);

  // Resolve the live credential's owner BEFORE touching the network: a refused
  // swap must refuse with the target's parked token still valid. The refresh
  // rotates it server-side, and codex punishes reuse of the superseded one, so
  // rotating first and then throwing would kill the target's grant family
  // (adversarial review catch, 2026-07-16).
  const live = readLiveCodexAuth();
  let liveOwner = null;
  if (live) {
    const liveIdentity = codexIdentityOf({ auth: live });
    // Backstop against a drifted caller: installing the LIVE account over
    // itself would refresh its superseded parked token (reuse punishment kills
    // the grant family) and rotate the token out from under a running session.
    if (liveIdentity.accountId === target.accountId) {
      throw new Error(
        `${target.label} is already the live codex credential - refusing to swap an account onto itself`,
      );
    }
    liveOwner = index.accounts.find((account) => account.accountId === liveIdentity.accountId) ?? null;
    if (!liveOwner) {
      throw new Error(
        `live codex credential belongs to ${liveIdentity.email ?? liveIdentity.accountId.slice(0, 8)}, which is not in the pool - refusing to swap over it; import it first with \`tokenmaxxing add --codex\``,
      );
    }
    if (liveOwner.accountId !== index.activeAccountId) {
      log("codexswap.harvest_drift", {
        labeled: index.activeAccountId?.slice(0, 8) ?? null,
        actual: liveOwner.accountId.slice(0, 8),
      });
    }
  }

  let fresh;
  try {
    fresh = await refreshCodexAuth({ auth: parked });
  } catch (e) {
    if (e instanceof CodexInvalidGrantError) {
      const entry = index.accounts.find((account) => account.accountId === target.accountId);
      if (entry) {
        entry.needsReauth = true;
        saveCodexAccounts({ index });
      }
      log("codexswap.invalid_grant", { account: target.accountId.slice(0, 8) });
    }
    throw e;
  }
  // The rotation exists server-side from this instant: persist it before ANY
  // later step can fail, or a crash strands the parked file on the superseded
  // (reuse-punished) refresh token.
  writeParkedCodexAuth({ credFile: target.credFile, auth: fresh });

  if (live && liveOwner) {
    // Last-moment re-read: a running codex (the Apps surface) can rotate the
    // live token outside our flock between the identity resolution above and
    // this harvest, and parking the earlier snapshot would strand the newest
    // rotation of a reuse-punished grant family. A mid-swap identity change
    // refuses rather than harvesting under a stale owner.
    const liveNow = readLiveCodexAuth();
    if (!liveNow || codexIdentityOf({ auth: liveNow }).accountId !== liveOwner.accountId) {
      throw new Error("live codex credential changed mid-swap - refusing to harvest under a stale identity; retry");
    }
    writeParkedCodexAuth({ credFile: liveOwner.credFile, auth: liveNow });
    log("codexswap.harvest", { account: liveOwner.accountId.slice(0, 8) });
  }

  writeLiveCodexAuth({ auth: fresh });
  index.activeAccountId = target.accountId;
  const entry = index.accounts.find((account) => account.accountId === target.accountId);
  if (entry) entry.needsReauth = false;
  saveCodexAccounts({ index });
  saveCodexLastSwapAt({ ts: Date.now() });
  log("codexswap.done", { account: target.accountId.slice(0, 8), label: target.label });
}

