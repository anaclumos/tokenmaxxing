// `tokenmaxxing rename <selector> <new-label>` - relabel a pooled account.

import { withLock } from "../lib/lock.ts";
import { paths } from "../lib/paths.ts";
import { loadAccounts, saveAccounts } from "../lib/state.ts";
import { c } from "./render.ts";
import type { Account } from "../lib/types.ts";

/** Resolve an account by email, label, or accountUuid prefix. */
export function findAccount(accounts: Account[], selector: string): Account | undefined {
  const s = selector.toLowerCase();
  return (
    accounts.find((a) => a.email.toLowerCase() === s) ??
    accounts.find((a) => a.label.toLowerCase() === s) ??
    accounts.find((a) => a.accountUuid.toLowerCase().startsWith(s))
  );
}

export async function cmdRename(selector?: string, newLabel?: string): Promise<number> {
  if (!selector || !newLabel) {
    console.error("usage: tokenmaxxing rename <email|label|uuid> <new-label>");
    return 2;
  }
  // under the flock: a concurrent swap's index write must not be clobbered.
  return withLock(paths.lockFile, async () => {
    const idx = loadAccounts();
    const a = findAccount(idx.accounts, selector);
    if (!a) {
      console.error(c.red(`no account matches "${selector}"`));
      return 1;
    }
    const old = a.label;
    a.label = newLabel;
    saveAccounts(idx);
    console.log(`renamed ${c.dim(old)} → ${c.bold(newLabel)}`);
    return 0;
  });
}
