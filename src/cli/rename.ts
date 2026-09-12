import { withLock } from "../lib/lock.ts";
import type { Provider } from "../lib/provider.ts";
import { loadAccounts, saveAccounts } from "../lib/state.ts";
import { c, emitError, plain } from "./render.ts";
import type { Account } from "../lib/types.ts";

export function findAccount(accounts: Account[], selector: string): Account | undefined {
  const s = selector.toLowerCase();
  return (
    accounts.find((a) => a.email?.toLowerCase() === s) ??
    accounts.find((a) => a.label.toLowerCase() === s) ??
    accounts.find((a) => a.id.toLowerCase().startsWith(s))
  );
}

export async function cmdRename(p: Provider, argv: string[]): Promise<number> {
  const [selector, newLabel] = argv;
  if (!selector || !newLabel) {
    emitError({ message: "usage: tokenmaxxing rename [--codex] <email|label|id> <new-label>", paint: plain });
    return 2;
  }
  return withLock(p.pool.lockFile, async () => {
    const idx = loadAccounts(p.pool);
    const a = findAccount(idx.accounts, selector);
    if (!a) {
      emitError({ message: `no ${p.name} account matches "${selector}"` });
      return 1;
    }
    const taken = idx.accounts.find((x) => x.id !== a.id && x.label.toLowerCase() === newLabel.toLowerCase());
    if (taken) {
      emitError({ message: `label "${newLabel}" is already used by ${taken.email ?? taken.id.slice(0, 8)} - labels must be unique within the pool` });
      return 1;
    }
    const old = a.label;
    a.label = newLabel;
    saveAccounts(p.pool, idx);
    console.log(`renamed ${c.dim(old)} → ${c.bold(newLabel)}`);
    return 0;
  });
}
