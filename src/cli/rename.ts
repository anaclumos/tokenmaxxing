import { withLock } from "../lib/lock.ts";
import { codexPaths, paths } from "../lib/paths.ts";
import { loadAccounts, saveAccounts } from "../lib/state.ts";
import { loadCodexAccounts, saveCodexAccounts } from "../lib/codexstate.ts";
import { c, emitError, plain } from "./render.ts";
import type { Account, CodexAccount } from "../lib/types.ts";

export function findAccount(accounts: Account[], selector: string): Account | undefined {
  const s = selector.toLowerCase();
  return (
    accounts.find((a) => a.email.toLowerCase() === s) ??
    accounts.find((a) => a.label.toLowerCase() === s) ??
    accounts.find((a) => a.accountUuid.toLowerCase().startsWith(s))
  );
}

export function findCodexAccount(accounts: CodexAccount[], selector: string): CodexAccount | undefined {
  const s = selector.toLowerCase();
  return (
    accounts.find((a) => a.email?.toLowerCase() === s) ??
    accounts.find((a) => a.label.toLowerCase() === s) ??
    accounts.find((a) => a.accountId.toLowerCase().startsWith(s))
  );
}

async function renameCodexAccount(input: { selector: string; newLabel: string }): Promise<number> {
  const { selector, newLabel } = input;
  return withLock(codexPaths.lockFile, async () => {
    const index = loadCodexAccounts();
    const account = findCodexAccount(index.accounts, selector);
    if (!account) {
      emitError({ message: `no codex account matches "${selector}"` });
      return 1;
    }
    const taken = index.accounts.find((x) => x.accountId !== account.accountId && x.label.toLowerCase() === newLabel.toLowerCase());
    if (taken) {
      emitError({ message: `label "${newLabel}" is already used by ${taken.accountId.slice(0, 8)} - labels must be unique within the pool` });
      return 1;
    }
    const old = account.label;
    account.label = newLabel;
    saveCodexAccounts({ index });
    console.log(`renamed codex account ${c.dim(old)} → ${c.bold(newLabel)}`);
    return 0;
  });
}

export async function cmdRename(argv: string[]): Promise<number> {
  const codex = argv.includes("--codex");
  const [selector, newLabel] = argv.filter((a) => a !== "--codex");
  if (!selector || !newLabel) {
    emitError({ message: "usage: tokenmaxxing rename [--codex] <email|label|id> <new-label>", paint: plain });
    return 2;
  }
  if (codex) return renameCodexAccount({ selector, newLabel });
  return withLock(paths.lockFile, async () => {
    const idx = loadAccounts();
    const a = findAccount(idx.accounts, selector);
    if (!a) {
      emitError({ message: `no claude account matches "${selector}" (codex accounts rename via --codex)` });
      return 1;
    }
    const taken = idx.accounts.find((x) => x.accountUuid !== a.accountUuid && x.label.toLowerCase() === newLabel.toLowerCase());
    if (taken) {
      emitError({ message: `label "${newLabel}" is already used by ${taken.email} - labels must be unique within the pool` });
      return 1;
    }
    const old = a.label;
    a.label = newLabel;
    saveAccounts(idx);
    console.log(`renamed ${c.dim(old)} → ${c.bold(newLabel)}`);
    return 0;
  });
}
