import { withLock } from "../lib/lock.ts";
import { codexPaths } from "../lib/paths.ts";
import { loadCodexAccounts, saveCodexAccounts } from "../lib/codexstate.ts";
import { deleteParkedCodexAuth } from "../lib/codexauth.ts";
import { liveCodexAccountId } from "../lib/codexsample.ts";
import { presentCodexAccountIds } from "../lib/codexpresence.ts";
import { findCodexAccount } from "./rename.ts";
import { c } from "./render.ts";

export async function cmdCodexRm(selector?: string): Promise<number> {
  if (!selector) {
    console.error("usage: tokenmaxxing rm --codex <email|label|id>");
    return 2;
  }
  return withLock(codexPaths.lockFile, async () => {
    const index = loadCodexAccounts();
    const account = findCodexAccount(index.accounts, selector);
    if (!account) {
      console.error(c.red(`no codex account matches "${selector}"`));
      return 1;
    }
    if (liveCodexAccountId() === account.accountId) {
      console.error(c.red(`${account.label} is the LIVE codex account - run \`tokenmaxxing switch --codex\` to move off it first.`));
      return 1;
    }
    if (presentCodexAccountIds().has(account.accountId)) {
      console.error(c.red(`${account.label} is running in a live codex session - close that session before removing it.`));
      return 1;
    }
    deleteParkedCodexAuth({ credFile: account.credFile });
    index.accounts = index.accounts.filter((x) => x.accountId !== account.accountId);
    saveCodexAccounts({ index });
    console.log(`removed codex account ${c.bold(account.label)} from the pool (${index.accounts.length} left)`);
    return 0;
  });
}
