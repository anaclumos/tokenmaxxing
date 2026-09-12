import { withLock } from "../lib/lock.ts";
import { codexPaths } from "../lib/paths.ts";
import { loadCodexAccounts, saveCodexAccounts } from "../lib/codexstate.ts";
import { deleteParkedCodexAuth } from "../lib/codexauth.ts";
import { liveCodexAccountId } from "../lib/codexsample.ts";
import { presentCodexAccountIds } from "../lib/codexpresence.ts";
import { findCodexAccount } from "./rename.ts";
import { c, emitError, plain } from "./render.ts";

export async function cmdCodexRm(selector?: string): Promise<number> {
  if (!selector) {
    emitError({ message: "usage: tokenmaxxing rm --codex <email|label|id>", paint: plain });
    return 2;
  }
  return withLock(codexPaths.lockFile, async () => {
    const index = loadCodexAccounts();
    const account = findCodexAccount(index.accounts, selector);
    if (!account) {
      emitError({ message: `no codex account matches "${selector}"` });
      return 1;
    }
    if (liveCodexAccountId() === account.accountId) {
      emitError({ message: `${account.label} is the LIVE codex account - run \`tokenmaxxing switch --codex\` to move off it first.` });
      return 1;
    }
    if (presentCodexAccountIds().has(account.accountId)) {
      emitError({ message: `${account.label} is running in a live codex session - close that session before removing it.` });
      return 1;
    }
    deleteParkedCodexAuth({ credFile: account.credFile });
    index.accounts = index.accounts.filter((x) => x.accountId !== account.accountId);
    saveCodexAccounts({ index });
    console.log(`removed codex account ${c.bold(account.label)} from the pool (${index.accounts.length} left)`);
    return 0;
  });
}
