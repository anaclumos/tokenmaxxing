import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const HOME = homedir();

const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);

export function env(name: string, fallback: string): string {
  return EnvOverrideSchema.parse(process.env[name]) ?? fallback;
}

const TM_HOME = env("TOKENMAXXING_HOME", join(HOME, ".config", "tokenmaxxing"));

export const paths = {
  home: TM_HOME,
  configJson: join(TM_HOME, "config.json"),
  usageDir: join(TM_HOME, "usage"),
  respawnDir: join(TM_HOME, "respawn"),
  presenceDir: join(TM_HOME, "live"),
  binDir: join(TM_HOME, "bin"),
  supervisorLink: join(TM_HOME, "bin", "claude"),
  logFile: join(TM_HOME, "tokenmaxxing.log"),
  onboardDir: join(TM_HOME, "onboard"),
  sampleDir: join(TM_HOME, "sample"),
  storesDir: join(TM_HOME, "stores"),
  setupTokensJson: join(TM_HOME, "setup-tokens.json"),
  setupTokenDir: join(TM_HOME, "setup-token"),
  cloudSessionsJson: join(TM_HOME, "cloud", "sessions.json"),
  cloudWalledJson: join(TM_HOME, "cloud", "walled.json"),
  cloudLockFile: join(TM_HOME, "cloud", "lock"),

  claudeSettings: env(
    "TOKENMAXXING_CLAUDE_SETTINGS",
    join(env("CLAUDE_CONFIG_DIR", join(HOME, ".claude")), "settings.json"),
  ),
  claudeDir: env("CLAUDE_CONFIG_DIR", join(HOME, ".claude")),

  launchdAgentsDir: env("TOKENMAXXING_LAUNCHD_DIR", join(HOME, "Library", "LaunchAgents")),
  systemdUserDir: env("TOKENMAXXING_SYSTEMD_USER_DIR", join(HOME, ".config", "systemd", "user")),
} as const;

export const claudePool = {
  accountsJson: join(TM_HOME, "accounts.json"),
  lastSwapJson: null,
  lockFile: join(TM_HOME, "lock"),
} as const;

export const codexPool = {
  accountsJson: join(TM_HOME, "codex-accounts.json"),
  lastSwapJson: join(TM_HOME, "codex-lastswap.json"),
  lockFile: join(TM_HOME, "codex-lock"),
} as const;

export type PoolPaths = { accountsJson: string; lastSwapJson: string | null; lockFile: string };

const CODEX_HOME = env("TOKENMAXXING_CODEX_HOME", env("CODEX_HOME", join(HOME, ".codex")));

export const codexPaths = {
  home: CODEX_HOME,
  authJson: join(CODEX_HOME, "auth.json"),
  hooksJson: join(CODEX_HOME, "hooks.json"),
  credsDir: join(TM_HOME, "codex-creds"),
  onboardDir: join(TM_HOME, "codex-onboard"),
  respawnDir: join(TM_HOME, "codex-respawn"),
  presenceDir: join(TM_HOME, "codex-live"),
  reconcileDir: join(TM_HOME, "codex-reconcile"),
} as const;

export function codexCredItemFor(accountId: string): string {
  return `tokenmaxxing-codex-${accountId.slice(0, 8)}`;
}

export const keychain = {
  account: env("TOKENMAXXING_KEYCHAIN_ACCOUNT", process.env.USER ?? "unknown"),
} as const;

export function shortId(accountId: string): string {
  return accountId.slice(0, 8);
}

export function storeDirFor(accountId: string): string {
  return join(paths.storesDir, shortId(accountId));
}

export function sampleDirFor(accountId: string, suffix = ""): string {
  return join(paths.sampleDir, `${shortId(accountId)}${suffix}`);
}

export function usageJsonFor(accountId: string): string {
  return join(paths.usageDir, `${shortId(accountId)}.json`);
}

export function seatFromEnv(accountIds: string[], env: Record<string, string | undefined> = process.env): string | null {
  const store = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (store == null || store === "") return null;
  return accountIds.find((id) => storeDirFor(id) === store) ?? null;
}

export function namespacedCredService(configDirRaw: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(configDirRaw.normalize("NFC"));
  return `Claude Code-credentials-${h.digest("hex").slice(0, 8)}`;
}

export function realClaudeBinFromEnv(): string | undefined {
  return EnvOverrideSchema.parse(process.env.TOKENMAXXING_CLAUDE_BIN);
}

export function realCodexBinFromEnv(): string | undefined {
  return EnvOverrideSchema.parse(process.env.TOKENMAXXING_CODEX_BIN);
}

export { HOME };
