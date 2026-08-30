import { withLock } from "../lib/lock.ts";
import { loadAccounts, saveAccounts } from "../lib/state.ts";
import { credItemFor, paths } from "../lib/paths.ts";
import { writeItem, parkedTarget, claudeAiOauthOnly } from "../lib/credstore.ts";
import { harvestIsolatedLogin } from "./onboard.ts";
import { type Account } from "../lib/types.ts";
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
    const existing = idx.accounts.find((a) => a.accountUuid === uuid);
    const fresh: Account = {
      accountUuid: uuid,
      email: oauthAccount.emailAddress,
      organizationUuid: oauthAccount.organizationUuid,
      label: existing?.label ?? oauthAccount.emailAddress,
      keychainItem,
      oauthAccount,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      subscriptionType: blob.claudeAiOauth.subscriptionType,
      rateLimitTier: blob.claudeAiOauth.rateLimitTier,
      needsReauth: false,
      lastUsage: sampled ? { fiveHour: sampled.session, sevenDay: sampled.weekAll } : existing?.lastUsage,
      lastPerModel: sampled && Object.keys(sampled.perModel).length > 0 ? sampled.perModel : existing?.lastPerModel,
      lastPerModelAt: sampled && Object.keys(sampled.perModel).length > 0 ? Date.now() : existing?.lastPerModelAt,
      lastUsageAt: sampled ? Date.now() : existing?.lastUsageAt,
    };
    if (existing) Object.assign(existing, fresh);
    else idx.accounts.push(fresh);
    saveAccounts(idx);
    return { account: fresh, poolSize: idx.accounts.length };
  });

  console.log();
  const usageNote = sampled ? ` (session ${sampled.session.usedPercentage}% / week ${sampled.weekAll.usedPercentage}%)` : "";
  console.log(`${c.green("✓")} added ${c.bold(account.email)} (${claudeTierLabel(account) ?? "?"})${usageNote} → pool now has ${count({ n: poolSize, noun: "account" })}`);
  return 0;
}
