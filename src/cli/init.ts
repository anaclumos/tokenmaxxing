// `tokenmaxxing init` - import the account you're already on (no prompts), then
// install the supervisor + the three settings entries.

import { mkdirSync } from "node:fs";
import { isApiKeyMode, readOAuthAccount } from "../lib/claudejson.ts";
import { readItem, writeItem, liveTarget, parkedTarget, mergeIntoLive } from "../lib/credstore.ts";
import { refreshCredential, isAccessTokenExpiring, fetchTokenOrg } from "../lib/oauth.ts";
import { loadAccounts, saveAccounts, loadConfig, saveConfig } from "../lib/state.ts";
import { installSupervisor, shellRcPath, ensurePathInRc } from "../lib/install.ts";
import { resolveRealClaude } from "../lib/claudebin.ts";
import { credItemFor, paths } from "../lib/paths.ts";
import { CredentialBlobSchema, type Account } from "../lib/types.ts";
import { c } from "./render.ts";

/** Put the supervisor bin dir on PATH via the user's shell rc (idempotent).
 *  Falls back to the manual instruction when the shell is unknown. */
function ensurePathAhead(): void {
  const rc = shellRcPath();
  if (!rc) {
    console.log(c.yellow(`⚠ add to your shell rc: export PATH="${paths.binDir}:$PATH"`));
    return;
  }
  const outcome = ensurePathInRc(rc);
  if (outcome === "added") console.log(`${c.green("✓")} added ${paths.binDir} to PATH in ${rc} - restart your shell (or \`source ${rc}\`)`);
  else console.log(c.yellow(`⚠ PATH line already in ${rc} - restart your shell to pick it up`));
}

export async function cmdInit(): Promise<number> {
  mkdirSync(paths.home, { recursive: true });

  // Already initialized → repair install ONLY. Never re-import: ~/.claude.json's
  // oauthAccount can drift from the live keychain cred (after swaps / concurrent
  // sessions), and re-importing would park the wrong cred + mislabel active.
  const existingIdx = loadAccounts();
  if (existingIdx.accounts.length > 0) {
    const out = installSupervisor();
    // repair the claudeBin pin too - hooks run with claude's PATH and must
    // never have to guess which binary is the real claude.
    const cfg = loadConfig();
    cfg.claudeBin = resolveRealClaude();
    saveConfig(cfg);
    const active = existingIdx.accounts.find((a) => a.accountUuid === existingIdx.activeAccountUuid);
    console.log(`${c.green("✓")} re-installed supervisor + hooks (pool already has ${existingIdx.accounts.length} account${existingIdx.accounts.length === 1 ? "" : "s"} - not re-importing)`);
    if (!out.pathAhead) ensurePathAhead();
    console.log(`  active: ${c.bold(active?.label ?? "unknown")} · run ${c.cyan("tokenmaxxing add")} for more, ${c.cyan("tokenmaxxing status")} to check`);
    return 0;
  }

  if (isApiKeyMode()) {
    console.error(c.yellow("tokenmaxxing pools subscription accounts, but you're authed via API key / apiKeyHelper."));
    console.error(`Run ${c.cyan("claude")} → ${c.cyan("/login")} with a Pro/Max account first, then re-run ${c.cyan("tokenmaxxing init")}.`);
    return 1;
  }

  const oauthAccount = readOAuthAccount();
  const liveRaw = await readItem(liveTarget());
  if (!oauthAccount || !liveRaw) {
    console.error(c.red("no active Claude subscription login found (missing oauthAccount or credential)."));
    console.error(`Run ${c.cyan("claude")} → ${c.cyan("/login")} first, then re-run ${c.cyan("tokenmaxxing init")}.`);
    return 1;
  }

  let blob;
  try {
    blob = CredentialBlobSchema.parse(JSON.parse(liveRaw));
  } catch {
    console.error(c.red("the live credential is not a recognizable Claude OAuth blob."));
    return 1;
  }

  // Verify the live credential actually belongs to the identity we're about to
  // file it under - ~/.claude.json's oauthAccount can drift from the live
  // keychain credential, and importing on drifted state parks a mislabeled blob.
  let creds = blob.claudeAiOauth;
  if (isAccessTokenExpiring(creds)) {
    creds = await refreshCredential(creds);
    await writeItem(liveTarget(), mergeIntoLive(liveRaw, creds));
  }
  const org = await fetchTokenOrg(creds.accessToken);
  if (org.organization_uuid !== oauthAccount.organizationUuid) {
    console.error(c.red(`the live credential belongs to ${org.organization_name}, but ~/.claude.json identifies ${oauthAccount.emailAddress} - identity drift.`));
    console.error(`Run ${c.cyan("claude")} → ${c.cyan("/login")} to realign them, then re-run ${c.cyan("tokenmaxxing init")}.`);
    return 1;
  }

  const uuid = oauthAccount.accountUuid;
  const keychainItem = credItemFor(uuid);
  await writeItem(parkedTarget(keychainItem), JSON.stringify({ claudeAiOauth: creds })); // park a small backup

  const idx = loadAccounts();
  const existing = idx.accounts.find((a) => a.accountUuid === uuid);
  const account: Account = {
    accountUuid: uuid,
    email: oauthAccount.emailAddress,
    organizationUuid: oauthAccount.organizationUuid,
    label: existing?.label ?? oauthAccount.emailAddress,
    keychainItem,
    oauthAccount,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    subscriptionType: blob.claudeAiOauth.subscriptionType,
    needsReauth: false,
  };
  if (existing) Object.assign(existing, account);
  else idx.accounts.push(account);
  idx.activeAccountUuid = uuid;
  saveAccounts(idx);

  const cfg = loadConfig();
  cfg.claudeBin = resolveRealClaude();
  saveConfig(cfg);

  const out = installSupervisor();

  console.log(`${c.green("✓")} imported current account → ${c.bold(account.email)} (${account.subscriptionType ?? "?"})`);
  console.log(`${c.green("✓")} installed ${c.bold("claude")} supervisor + statusLine/Stop/SessionStart hooks`);
  if (out.priorStatusLine) console.log(`${c.green("✓")} wrapped your existing statusLine (preserved)`);
  if (!out.pathAhead) {
    console.log();
    ensurePathAhead();
  }
  console.log();
  console.log(`  pool ready (${idx.accounts.length} account${idx.accounts.length === 1 ? "" : "s"}) · add more with ${c.cyan("tokenmaxxing add")}`);
  return 0;
}
