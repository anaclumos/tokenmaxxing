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
    if (a.id === idx.activeId) {
      emitError({ message: `${a.label} is the ACTIVE account - switch away before removing it.` });
      return 1;
    }
    let liveOwner: string | null;
    try {
      liveOwner = await p.liveOwner();
    } catch (e) {
      emitError({
        message: `cannot verify which account the LIVE credential belongs to (${e instanceof Error ? e.message : String(e)}) - refusing to remove while the live owner is unknown; repair the live credential or retry once the profile endpoint is reachable.`,
      });
      return 1;
    }
    if (liveOwner === a.id) {
      emitError({ message: `${a.label}'s credential is currently LIVE (the active label is stale - a manual login drifted it); run \`tokenmaxxing switch${p.flag}\` to move off it first.` });
      return 1;
    }
    if (p.presentIds().has(a.id)) {
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
