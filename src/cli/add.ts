import { withLock } from "../lib/lock.ts";
import { importedAccount, loadAccounts, saveAccounts, upsertAccount } from "../lib/state.ts";
import { credItemFor, paths } from "../lib/paths.ts";
import { writeItem, parkedTarget, claudeAiOauthOnly } from "../lib/credstore.ts";
import { harvestIsolatedLogin } from "./onboard.ts";
import { c, claudeTierLabel, count } from "./render.ts";

export async function cmdAdd(): Promise<number> {
  console.log(c.cyan("Opening an isolated Claude login - your primary login is untouched."));
  console.log(c.dim(`In the session that opens, run  ${c.bold("/login")}  with the account to add. It closes itself once you're in.`));
  console.log();

  const harvested = await harvestIsolatedLogin();
  if (!harvested) return 1;
  const { blobRaw, blob, oauthAccount, sampled } = harvested;

  const uuid = oauthAccount.accountUuid;
  const keychainItem = credItemFor(uuid);

  const { account, poolSize } = await withLock(paths.lockFile, async () => {
    await writeItem(parkedTarget(keychainItem), claudeAiOauthOnly(blobRaw));
    const idx = loadAccounts();
    const fresh = importedAccount({ existing: idx.accounts.find((a) => a.accountUuid === uuid), oauthAccount, keychainItem, creds: blob.claudeAiOauth, sampled });
    upsertAccount(idx, fresh);
    saveAccounts(idx);
    return { account: fresh, poolSize: idx.accounts.length };
  });

  console.log();
  const usageNote = sampled ? ` (session ${sampled.session.usedPercentage}% / week ${sampled.weekAll.usedPercentage}%)` : "";
  console.log(`${c.green("✓")} added ${c.bold(account.email)} (${claudeTierLabel(account) ?? "?"})${usageNote} → pool now has ${count({ n: poolSize, noun: "account" })}`);
  return 0;
}
