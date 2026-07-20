// `tokenmaxxing rm --codex <selector>` - remove a pooled codex account (not
// the live one). Until this existed the uninstall message pointed users at
// `xx rm` for every parked credential while codex blobs were unremovable
// (adversarial-review catch).

import { rmSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../lib/lock.ts";
import { codexPaths } from "../lib/paths.ts";
import { loadCodexAccounts, saveCodexAccounts } from "../lib/codexstate.ts";
import { liveCodexAccountId } from "../lib/codexsample.ts";
import { presentCodexAccountIds } from "../lib/codexpresence.ts";
import { findCodexAccount } from "./rename.ts";
import { c } from "./render.ts";

export async function cmdCodexRm(selector?: string): Promise<number> {
  if (!selector) {
    console.error("usage: tokenmaxxing rm --codex <email|label|id>");
    return 2;
  }
  // under the codex flock: a concurrent swap's index write must not be clobbered.
  return withLock(codexPaths.lockFile, async () => {
    const index = loadCodexAccounts();
    const account = findCodexAccount(index.accounts, selector);
    if (!account) {
      console.error(c.red(`no codex account matches "${selector}"`));
      return 1;
    }
    // The live identity is decoded from auth.json itself (id_token claims),
    // offline ground truth - labels drift, the blob cannot lie. An unreadable
    // live blob THROWS out of liveCodexAccountId (the codex loaders' contract),
    // which fails this destructive command loudly rather than trusting a label.
    if (liveCodexAccountId() === account.accountId) {
      console.error(c.red(`${account.label} is the LIVE codex account - run \`tokenmaxxing switch --codex\` to move off it first.`));
      return 1;
    }
    if (presentCodexAccountIds().has(account.accountId)) {
      console.error(c.red(`${account.label} is running in a live codex session - close that session before removing it.`));
      return 1;
    }
    // Parked codex blobs are plain 0600 files; hard delete on purpose (the
    // credential-dir cleanup exception - trashing would move a credential
    // into the Trash folder).
    rmSync(join(codexPaths.credsDir, account.credFile), { force: true });
    index.accounts = index.accounts.filter((x) => x.accountId !== account.accountId);
    saveCodexAccounts({ index });
    console.log(`removed codex account ${c.bold(account.label)} from the pool (${index.accounts.length} left)`);
    return 0;
  });
}
