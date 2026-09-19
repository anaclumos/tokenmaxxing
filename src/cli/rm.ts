import { withLock } from "../lib/lock.ts";
import type { Provider } from "../lib/provider.ts";
import { loadAccounts, saveAccounts } from "../lib/state.ts";
import { findAccount } from "./rename.ts";
import { c, emitError, plain } from "./render.ts";

export async function cmdRm(p: Provider, selector?: string): Promise<number> {
  if (!selector) {
    emitError({ message: `usage: tokenmaxxing rm${p.flag} <email|label|id>`, paint: plain });
    return 2;
  }
  return withLock(p.pool.lockFile, async () => {
    const idx = loadAccounts(p.pool);
    const a = findAccount(idx.accounts, selector);
    if (!a) {
      emitError({ message: `no account matches "${selector}"` });
      return 1;
    }
    if (p.liveId() === a.id) {
      emitError({ message: `${a.label} is the ${p.name} login this command runs under - remove it from a session on another account.` });
      return 1;
    }
    if (p.presence().has(a.id)) {
      emitError({ message: `${a.label} is running in a live ${p.name} session - close that session before removing it.` });
      return 1;
    }
    await p.removeCredentials(a);
    idx.accounts = idx.accounts.filter((x) => x.id !== a.id);
    saveAccounts(p.pool, idx);
    console.log(`removed ${c.bold(a.label)} from the pool (${idx.accounts.length} left)`);
    return 0;
  });
}
