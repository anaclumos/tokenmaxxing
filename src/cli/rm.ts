// `tokenmaxxing rm <selector>` - remove a pooled account (not the active one).

import { deleteItem, liveTarget, parkedTarget, readItem } from "../lib/credstore.ts";
import { isAccessTokenExpiring, fetchTokenOrg } from "../lib/oauth.ts";
import { withLock } from "../lib/lock.ts";
import { paths } from "../lib/paths.ts";
import { loadAccounts, saveAccounts } from "../lib/state.ts";
import { CredentialBlobSchema } from "../lib/types.ts";
import { findAccount } from "./rename.ts";
import { c } from "./render.ts";

export async function cmdRm(selector?: string): Promise<number> {
  if (!selector) {
    console.error("usage: tokenmaxxing rm <email|label|uuid>");
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
    if (a.accountUuid === idx.activeAccountUuid) {
      console.error(c.red(`${a.email} is the ACTIVE account - switch away before removing it.`));
      return 1;
    }
    // The label drifts (manual /login); the token cannot lie. Removing the
    // account whose credential is actually LIVE would destroy its only backup
    // and leave the next swap refusing over an unpooled credential. Read-only:
    // rm must never rotate anything, so an expiring token skips the check (the
    // active-label guard above still covers the common case).
    const live = await readItem(liveTarget());
    if (live != null) {
      const liveCreds = CredentialBlobSchema.parse(JSON.parse(live)).claudeAiOauth;
      if (!isAccessTokenExpiring(liveCreds)) {
        const org = await fetchTokenOrg(liveCreds.accessToken);
        if (org.organization_uuid === a.organizationUuid) {
          console.error(c.red(`${a.email}'s credential is currently LIVE (the active label is stale - a manual /login drifted it); run \`tokenmaxxing switch\` to move off it first.`));
          return 1;
        }
      }
    }
    await deleteItem(parkedTarget(a.keychainItem));
    idx.accounts = idx.accounts.filter((x) => x.accountUuid !== a.accountUuid);
    saveAccounts(idx);
    console.log(`removed ${c.bold(a.label)} from the pool (${idx.accounts.length} left)`);
    return 0;
  });
}
