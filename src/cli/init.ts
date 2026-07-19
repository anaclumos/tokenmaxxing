// `tokenmaxxing init` - import the account you're already on (no prompts), then
// install the supervisor + the three settings entries.

import { mkdirSync } from "node:fs";
import { isApiKeyMode, readOAuthAccount } from "../lib/claudejson.ts";
import { readItem, writeItem, liveTarget, parkedTarget, mergeIntoLive } from "../lib/credstore.ts";
import { refreshCredential, isAccessTokenExpiring, fetchTokenOrg } from "../lib/oauth.ts";
import { withClaudeRefreshLock } from "../lib/claudelock.ts";
import { loadAccounts, saveAccounts, loadConfig, pinBinOverride } from "../lib/state.ts";
import { withLock } from "../lib/lock.ts";
import { installSupervisor, shellRcPath, ensurePathInRc, timerActivationHint, type InstallOutcome } from "../lib/install.ts";
import { resolveVerifiedClaude } from "../lib/claudebin.ts";
import { credItemFor, paths } from "../lib/paths.ts";
import { CredentialBlobSchema, type Account } from "../lib/types.ts";
import { c, claudeTierLabel } from "./render.ts";

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

function reportTimer(out: InstallOutcome): void {
  if (out.timerLoaded) console.log(`${c.green("✓")} periodic check timer active (every 3m)`);
  else console.log(c.yellow(`⚠ check timer written but not activated - run: ${timerActivationHint()}`));
}

/** The how-to-use epilogue both init paths end on: the whole point of the tool
 *  is that after init you just run `claude`, so say exactly that, and teach the
 *  `xx` shorthand every other command hangs off. Exported for the render test. */
export function printUsage(): void {
  console.log();
  console.log(`  ${c.bold("how to use")} - ${c.cyan("xx")} is shorthand for ${c.cyan("tokenmaxxing")}:`);
  console.log(`    ${c.cyan("claude")}             use claude as always; it switches accounts near quota automatically`);
  console.log(`    ${c.cyan("xx")}                 show the pool with usage bars (same as ${c.cyan("xx status")})`);
  console.log(`    ${c.cyan("xx status --force")}  ping every account (one tiny haiku request each) so all 5h timers start now, then sample fresh`);
  console.log(`    ${c.cyan("xx add")}             log in and pool another account`);
  console.log(`    ${c.cyan("xx switch")}          hop to the best account right now (the automatic switching needs no command)`);
  console.log(`    ${c.cyan("xx help")}            everything else`);
}

export async function cmdInit(): Promise<number> {
  mkdirSync(paths.home, { recursive: true });
  // Fail fast on a broken merged config BEFORE installing or claiming a
  // successful repair: pinBinOverride writes sparsely without validating, so
  // without this gate a re-init printed success while hooks, switching, and
  // the statusline kept throwing on every loadConfig until the file was
  // hand-repaired (bugbot review catch, PR #33). The throw carries the
  // fix-or-remove recovery message.
  loadConfig();

  // Already initialized → repair install ONLY. Never re-import: ~/.claude.json's
  // oauthAccount can drift from the live keychain cred (after swaps / concurrent
  // sessions), and re-importing would park the wrong cred + mislabel active.
  const existingIdx = loadAccounts();
  if (existingIdx.accounts.length > 0) {
    const out = installSupervisor();
    // repair the claudeBin pin too - hooks run with claude's PATH and must
    // never have to guess which binary is the real claude. Verified pinning:
    // a pin that fails --version (or loops back into the wrapper) is replaced
    // by a fresh PATH scan instead of being re-saved. Sparse write: only the
    // pin lands in the file, never the merged config.
    pinBinOverride({ key: "claudeBin", bin: resolveVerifiedClaude() });
    const active = existingIdx.accounts.find((a) => a.accountUuid === existingIdx.activeAccountUuid);
    console.log(`${c.green("✓")} re-installed supervisor + hooks (pool already has ${existingIdx.accounts.length} account${existingIdx.accounts.length === 1 ? "" : "s"} - not re-importing)`);
    reportTimer(out);
    if (!out.pathAhead) ensurePathAhead();
    console.log(`  active: ${c.bold(active?.label ?? "unknown")}`);
    printUsage();
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
    await withClaudeRefreshLock(async (lock) => {
      // re-read inside the lock: a running claude may have rotated it already.
      const raw2 = await readItem(liveTarget());
      if (raw2 == null) throw new Error("live credential vanished while waiting for the refresh lock");
      const current = CredentialBlobSchema.parse(JSON.parse(raw2)).claudeAiOauth;
      creds = isAccessTokenExpiring(current) ? await refreshCredential(current) : current;
      if (creds === current) return;
      if (lock.compromised()) throw new Error("refresh lock compromised mid-refresh - discarding the live rewrite");
      await writeItem(liveTarget(), mergeIntoLive(raw2, creds));
    });
  }
  const org = await fetchTokenOrg(creds.accessToken);
  if (org.organization_uuid !== oauthAccount.organizationUuid) {
    console.error(c.red(`the live credential belongs to ${org.organization_name}, but ~/.claude.json identifies ${oauthAccount.emailAddress} - identity drift.`));
    console.error(`Run ${c.cyan("claude")} → ${c.cyan("/login")} to realign them, then re-run ${c.cyan("tokenmaxxing init")}.`);
    return 1;
  }

  const uuid = oauthAccount.accountUuid;
  const keychainItem = credItemFor(uuid);
  // Park + index update under the tokenmaxxing flock, like every sibling
  // index writer (add/auth/rm/status/rename): unlocked, a concurrent `xx add`
  // completing between this path's load and save had its just-registered
  // account silently clobbered out of the index (closing-review catch).
  const account = await withLock(paths.lockFile, async () => {
    await writeItem(parkedTarget(keychainItem), JSON.stringify({ claudeAiOauth: creds })); // park a small backup
    const idx = loadAccounts();
    const existing = idx.accounts.find((a) => a.accountUuid === uuid);
    const imported: Account = {
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
    };
    if (existing) Object.assign(existing, imported);
    else idx.accounts.push(imported);
    idx.activeAccountUuid = uuid;
    saveAccounts(idx);
    return imported;
  });

  // Sparse write: only the pin lands in the file, never the merged config.
  pinBinOverride({ key: "claudeBin", bin: resolveVerifiedClaude() });

  const out = installSupervisor();

  console.log(`${c.green("✓")} imported current account → ${c.bold(account.email)} (${claudeTierLabel(account) ?? "?"})`);
  console.log(`${c.green("✓")} installed ${c.bold("claude")} supervisor + statusLine/Stop/SessionStart hooks`);
  reportTimer(out);
  if (!out.pathAhead) {
    console.log();
    ensurePathAhead();
  }
  const poolSize = loadAccounts().accounts.length;
  console.log();
  console.log(`  pool ready (${poolSize} account${poolSize === 1 ? "" : "s"})`);
  printUsage();
  return 0;
}
