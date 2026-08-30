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

  const live = readLiveCodexAuth();
  let liveOwner = null;
  if (live) {
    const liveIdentity = codexIdentityOf({ auth: live });
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
  writeParkedCodexAuth({ credFile: target.credFile, auth: fresh });

  if (live && liveOwner) {
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

