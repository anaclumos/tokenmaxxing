import { rmSync } from "node:fs";
import { join } from "node:path";
import { deleteItem, isolatedTarget, liveTarget, parkedTarget, parseBlob, readItem } from "../lib/credstore.ts";
import { errorMessage } from "../lib/errors.ts";
import { fetchTokenIdentity } from "../lib/oauth.ts";
import { withLock } from "../lib/lock.ts";
import { credItemFor, paths } from "../lib/paths.ts";
import { loadAccounts, saveAccounts } from "../lib/state.ts";
import { findAccount } from "./rename.ts";
import { c, emitError, emitJson, plain } from "./render.ts";

export async function cmdRm(selector?: string, json = false): Promise<number> {
  if (!selector) {
    emitError({ json, message: "usage: tokenmaxxing rm <email|label|uuid>", paint: plain });
    return 2;
  }
  return withLock(paths.lockFile, async () => {
    const idx = loadAccounts();
    const a = findAccount(idx.accounts, selector);
    if (!a) {
      emitError({ json, message: `no account matches "${selector}"` });
      return 1;
    }
    if (a.accountUuid === idx.activeAccountUuid) {
      emitError({ json, message: `${a.email} is the ACTIVE account - switch away before removing it.` });
      return 1;
    }
    const live = await readItem(liveTarget());
    if (live != null) {
      let liveAccount: string;
      try {
        liveAccount = (await fetchTokenIdentity(parseBlob(live).claudeAiOauth.accessToken)).accountUuid;
      } catch (e) {
        emitError({
          json,
          message: `cannot verify which account the LIVE credential belongs to (${errorMessage(e)}) - refusing to remove while the live owner is unknown; repair the live credential or retry once the profile endpoint is reachable.`,
        });
        return 1;
      }
      if (liveAccount === a.accountUuid) {
        emitError({ json, message: `${a.email}'s credential is currently LIVE (the active label is stale - a manual /login drifted it); run \`tokenmaxxing switch\` to move off it first.` });
        return 1;
      }
    }
    await deleteItem(parkedTarget(a.keychainItem));
    const sampleDir = join(paths.sampleDir, credItemFor(a.accountUuid));
    await deleteItem(isolatedTarget(sampleDir));
    rmSync(sampleDir, { recursive: true, force: true });
    idx.accounts = idx.accounts.filter((x) => x.accountUuid !== a.accountUuid);
    saveAccounts(idx);
    if (json) emitJson({ ok: true, pool: "claude", removed: a.label, remaining: idx.accounts.length });
    else console.log(`removed ${c.bold(a.label)} from the pool (${idx.accounts.length} left)`);
    return 0;
  });
}
