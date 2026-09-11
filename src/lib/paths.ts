import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const HOME = homedir();

const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);

function env(name: string, fallback: string): string {
  return EnvOverrideSchema.parse(process.env[name]) ?? fallback;
}

const TM_HOME = env("TOKENMAXXING_HOME", join(HOME, ".config", "tokenmaxxing"));

export const paths = {
  home: TM_HOME,
  configJson: join(TM_HOME, "config.json"),
  accountsJson: join(TM_HOME, "accounts.json"),
  usageJson: join(TM_HOME, "usage.json"),
  modelUsageJson: join(TM_HOME, "model-usage.json"),
  lastSwapJson: join(TM_HOME, "lastswap.json"),
  depletedJson: join(TM_HOME, "depleted.json"),
  nextCheckJson: join(TM_HOME, "nextcheck.json"),
  respawnDir: join(TM_HOME, "respawn"),
  binDir: join(TM_HOME, "bin"),
  supervisorLink: join(TM_HOME, "bin", "claude"),
  lockFile: join(TM_HOME, "lock"),
  logFile: join(TM_HOME, "tokenmaxxing.log"),
  onboardDir: join(TM_HOME, "onboard"),
  sampleDir: join(TM_HOME, "sample"),
  credsDir: join(TM_HOME, "creds"),

  claudeJson: env("TOKENMAXXING_CLAUDE_JSON", join(HOME, ".claude.json")),
  claudeSettings: env(
    "TOKENMAXXING_CLAUDE_SETTINGS",
    join(env("CLAUDE_CONFIG_DIR", join(HOME, ".claude")), "settings.json"),
  ),
  claudeDir: env("CLAUDE_CONFIG_DIR", join(HOME, ".claude")),

  launchdAgentsDir: env("TOKENMAXXING_LAUNCHD_DIR", join(HOME, "Library", "LaunchAgents")),
  systemdUserDir: env("TOKENMAXXING_SYSTEMD_USER_DIR", join(HOME, ".config", "systemd", "user")),
} as const;

const CODEX_HOME = env("TOKENMAXXING_CODEX_HOME", env("CODEX_HOME", join(HOME, ".codex")));

export const codexPaths = {
  home: CODEX_HOME,
  authJson: join(CODEX_HOME, "auth.json"),
  hooksJson: join(CODEX_HOME, "hooks.json"),
  accountsJson: join(TM_HOME, "codex-accounts.json"),
  lastSwapJson: join(TM_HOME, "codex-lastswap.json"),
  lockFile: join(TM_HOME, "codex-lock"),
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
  service: env("TOKENMAXXING_KEYCHAIN_SERVICE", "Claude Code-credentials"),
  account: env("TOKENMAXXING_KEYCHAIN_ACCOUNT", process.env.USER ?? "unknown"),
} as const;

export function credItemFor(accountUuid: string): string {
  return `tokenmaxxing-cred-${accountUuid.slice(0, 8)}`;
}

export function credDir(): string {
  const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secure !== undefined) return (secure || join(HOME, ".claude")).normalize("NFC");
  return paths.claudeDir;
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
