import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readItem, deleteItem, isolatedTarget } from "../lib/credstore.ts";
import { resolveRealClaude } from "../lib/claudebin.ts";
import { CRED_ENV_OVERRIDES, probeUsage, FullUsageSchema } from "../lib/usage.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { paths } from "../lib/paths.ts";
import { CredentialBlobSchema, OAuthAccountSchema } from "../lib/types.ts";
import { c } from "./render.ts";

const HarvestedLoginSchema = z.object({
  blobRaw: z.string(),
  blob: CredentialBlobSchema,
  oauthAccount: OAuthAccountSchema,
  sampled: FullUsageSchema.nullable(),
});
export type HarvestedLogin = z.infer<typeof HarvestedLoginSchema>;

function identityReady(cjPath: string): boolean {
  if (!existsSync(cjPath)) return false;
  try {
    const oauthAccount = JSON.parse(readFileSync(cjPath, "utf8")).oauthAccount;
    return z.object({ accountUuid: z.string().min(1) }).safeParse(oauthAccount).success;
  } catch {
    return false;
  }
}

export async function harvestIsolatedLogin(): Promise<HarvestedLogin | null> {
  const onboardDir = paths.onboardDir;
  rmSync(onboardDir, { recursive: true, force: true });
  mkdirSync(onboardDir, { recursive: true });
  const iso = isolatedTarget(onboardDir);
  await deleteItem(iso);
  const cjPath = join(onboardDir, ".claude.json");
  const real = resolveRealClaude();

  const savedTermios = saveTermios();
  const env: Record<string, string> = { ...process.env, CLAUDE_CONFIG_DIR: onboardDir, TOKENMAXXING_PROBE: "1", TOKENMAXXING_SUPERVISED: "" };
  for (const key of CRED_ENV_OVERRIDES) delete env[key];
  const p = Bun.spawn([real], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });

  try {
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

    const blobRaw = await readItem(iso);
    if (!blobRaw || !identityReady(cjPath)) {
      console.error(c.red("no login detected in the isolated session - nothing changed."));
      return null;
    }

    let blob, oauthAccount;
    try {
      blob = CredentialBlobSchema.parse(JSON.parse(blobRaw));
      oauthAccount = OAuthAccountSchema.parse(JSON.parse(readFileSync(cjPath, "utf8")).oauthAccount);
    } catch {
      console.error(c.red("could not parse the onboarded account's credential/identity."));
      return null;
    }

    console.log(c.dim("sampling usage..."));
    const sampled = await probeUsage(onboardDir);
    if (!sampled) console.log(c.yellow("could not sample usage now - it will fill in on first use."));

    return { blobRaw, blob, oauthAccount, sampled };
  } finally {
    if (p.exitCode === null) {
      p.kill();
      await p.exited;
    }
    restoreTermios(savedTermios);
    await deleteItem(iso);
    rmSync(onboardDir, { recursive: true, force: true });
  }
}
