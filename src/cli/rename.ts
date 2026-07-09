// `tokenmaxxing rename <selector> <new-label>` - relabel a pooled account.

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

export function cmdRename(selector?: string, newLabel?: string): number {
  if (!selector || !newLabel) {
    console.error("usage: tokenmaxxing rename <email|label|uuid> <new-label>");
    return 2;
  }
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
}
