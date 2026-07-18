// One isolated Claude login, harvested. Shared by `add` (register whatever
// account the login lands on) and `auth` (require it to match an existing
// account). Drives the login in a throwaway CLAUDE_CONFIG_DIR - the ONLY use
// of CLAUDE_CONFIG_DIR in the tool - auto-exits the moment the login lands,
// samples that account's usage, then returns the credential + identity. The
// temp dir and isolated credential are always destroyed before returning.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readItem, deleteItem, isolatedTarget } from "../lib/credstore.ts";
import { resolveRealClaude } from "../lib/claudebin.ts";
import { probeUsage, FullUsageSchema } from "../lib/usage.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { paths } from "../lib/paths.ts";
import { CredentialBlobSchema, OAuthAccountSchema } from "../lib/types.ts";
import { c } from "./render.ts";

export const HarvestedLoginSchema = z.object({
  /** the raw isolated credential blob (park it via claudeAiOauthOnly). */
  blobRaw: z.string(),
  blob: CredentialBlobSchema,
  oauthAccount: OAuthAccountSchema,
  sampled: FullUsageSchema.nullable(),
});
export type HarvestedLogin = z.infer<typeof HarvestedLoginSchema>;

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

/**
 * Run one isolated login session and harvest it. The caller prints its own
 * instructions (which account to sign in as) BEFORE calling. Prints progress
 * and failure diagnostics; returns null when no usable login landed.
 */
export async function harvestIsolatedLogin(): Promise<HarvestedLogin | null> {
  const onboardDir = paths.onboardDir;
  rmSync(onboardDir, { recursive: true, force: true });
  mkdirSync(onboardDir, { recursive: true });
  const iso = isolatedTarget(onboardDir);
  const cjPath = join(onboardDir, ".claude.json");
  const real = resolveRealClaude();

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
    console.error(c.red("no login detected in the isolated session - nothing changed."));
    await cleanup();
    return null;
  }

  let blob, oauthAccount;
  try {
    blob = CredentialBlobSchema.parse(JSON.parse(blobRaw));
    oauthAccount = OAuthAccountSchema.parse(JSON.parse(readFileSync(cjPath, "utf8")).oauthAccount);
  } catch {
    console.error(c.red("could not parse the onboarded account's credential/identity."));
    await cleanup();
    return null;
  }

  // Sample usage now (#16) so the account isn't "not sampled yet" in status/ls.
  console.log(c.dim("sampling usage..."));
  const sampled = await probeUsage(onboardDir);
  if (!sampled) console.log(c.yellow("could not sample usage now - it will fill in on first use."));

  await cleanup();
  return { blobRaw, blob, oauthAccount, sampled };
}
