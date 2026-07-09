// `tokenmaxxing rm <selector>` - remove a pooled account (not the active one).

import { deleteItem, parkedTarget } from "../lib/credstore.ts";
import { loadAccounts, saveAccounts } from "../lib/state.ts";
import { findAccount } from "./rename.ts";
import { c } from "./render.ts";

export async function cmdRm(selector?: string): Promise<number> {
  if (!selector) {
    console.error("usage: tokenmaxxing rm <email|label|uuid>");
    return 2;
  }
  const idx = loadAccounts();
  const a = findAccount(idx.accounts, selector);
  if (!a) {
    console.error(c.red(`no account matches "${selector}"`));
    return 1;
  }
  if (a.accountUuid === idx.activeAccountUuid) {
    console.error(c.red(`${a.email} is the ACTIVE account - switch away before removing it.`));
    return 1;
  }
  await deleteItem(parkedTarget(a.keychainItem));
  idx.accounts = idx.accounts.filter((x) => x.accountUuid !== a.accountUuid);
  saveAccounts(idx);
  console.log(`removed ${c.bold(a.label)} from the pool (${idx.accounts.length} left)`);
  return 0;
}
