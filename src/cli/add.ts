// `tokenmaxxing add` - register an ADDITIONAL account. Logs one in inside a
// throwaway CLAUDE_CONFIG_DIR (the ONLY use of CLAUDE_CONFIG_DIR), auto-exits the
// moment the login lands, samples that account's usage, then harvests its
// credential + identity into the pool and deletes the temp dir + isolated
// credential. Your primary login is never touched.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readItem, writeItem, deleteItem, parkedTarget, isolatedTarget, claudeAiOauthOnly } from "../lib/credstore.ts";
import { resolveRealClaude } from "../lib/claudebin.ts";
import { probeUsage } from "../lib/usage.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { withLock } from "../lib/lock.ts";
import { loadAccounts, saveAccounts } from "../lib/state.ts";
import { credItemFor, paths } from "../lib/paths.ts";
import { CredentialBlobSchema, OAuthAccountSchema, type Account } from "../lib/types.ts";
import { c, claudeTierLabel, count } from "./render.ts";

/** True once `/login` has written a usable identity into the onboard dir. */
function identityReady(cjPath: string): boolean {
  if (!existsSync(cjPath)) return false;
  try {
    const oauthAccount = JSON.parse(readFileSync(cjPath, "utf8")).oauthAccount;
    return z.object({ accountUuid: z.string().min(1) }).safeParse(oauthAccount).success;
  } catch {
    return false;
  }
}

export async function cmdAdd(): Promise<number> {
  const onboardDir = paths.onboardDir;
  rmSync(onboardDir, { recursive: true, force: true });
  mkdirSync(onboardDir, { recursive: true });
  const iso = isolatedTarget(onboardDir);
  const cjPath = join(onboardDir, ".claude.json");
  const real = resolveRealClaude();

  console.log(c.cyan("Opening an isolated Claude login - your primary login is untouched."));
  console.log(c.dim(`In the session that opens, run  ${c.bold("/login")}  with the account to add. It closes itself once you're in.`));
  console.log();

  const savedTermios = saveTermios();
  // Scrub the ambient credential/identity overrides claude honors BEFORE its
  // keychain lookup (verified 2.1.205) - the onboard session must authenticate
  // only via the /login the user performs inside it.
  const env: Record<string, string> = { ...process.env, CLAUDE_CONFIG_DIR: onboardDir, TOKENMAXXING_PROBE: "1", TOKENMAXXING_SUPERVISED: "" };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const p = Bun.spawn([real], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });

  // Auto-exit (#17): watch for a completed login - identity written AND the
  // isolated credential present - then SIGTERM claude. No manual /exit.
  let exited = false;
  const onExit = p.exited.then(() => { exited = true; });
  while (!exited) {
    await Bun.sleep(400);
    if (identityReady(cjPath) && (await readItem(iso))) {
      p.kill();
      break;
    }
  }
  await p.exited;
  await onExit;
  restoreTermios(savedTermios);

  const cleanup = async () => {
    await deleteItem(iso);
    rmSync(onboardDir, { recursive: true, force: true });
  };

  const blobRaw = await readItem(iso);
  if (!blobRaw || !identityReady(cjPath)) {
    console.error(c.red("no login detected in the isolated session - nothing added."));
    await cleanup();
    return 1;
  }

  let blob, oauthAccount;
  try {
    blob = CredentialBlobSchema.parse(JSON.parse(blobRaw));
    oauthAccount = OAuthAccountSchema.parse(JSON.parse(readFileSync(cjPath, "utf8")).oauthAccount);
  } catch {
    console.error(c.red("could not parse the onboarded account's credential/identity."));
    await cleanup();
    return 1;
  }

  // Sample usage now (#16) so the account isn't "not sampled yet" in status/ls.
  console.log(c.dim("sampling usage..."));
  const sampled = await probeUsage(onboardDir);
  if (!sampled) console.log(c.yellow("could not sample usage now - it will fill in on first use."));

  const uuid = oauthAccount.accountUuid;
  const keychainItem = credItemFor(uuid);
  await writeItem(parkedTarget(keychainItem), claudeAiOauthOnly(blobRaw)); // park a small backup

  // under the flock: a concurrent swap's index write must not be clobbered.
  const { account, poolSize } = await withLock(paths.lockFile, async () => {
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
      lastUsageAt: sampled ? Date.now() : existing?.lastUsageAt,
    };
    if (existing) Object.assign(existing, fresh);
    else idx.accounts.push(fresh);
    saveAccounts(idx);
    return { account: fresh, poolSize: idx.accounts.length };
  });

  await cleanup();

  console.log();
  const usageNote = sampled ? ` (session ${sampled.session.usedPercentage}% / week ${sampled.weekAll.usedPercentage}%)` : "";
  console.log(`${c.green("✓")} added ${c.bold(account.email)} (${claudeTierLabel(account) ?? "?"})${usageNote} → pool now has ${count({ n: poolSize, noun: "account" })}`);
  return 0;
}
