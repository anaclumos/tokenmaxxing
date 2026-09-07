import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const HOME = homedir();

const EnvOverrideSchema = z.string().min(1).optional();

export function envOverride(name: string): string | undefined {
  const parsed = EnvOverrideSchema.safeParse(process.env[name]);
  if (!parsed.success) throw new Error(`${name} is set but empty - unset it or give it a value`);
  return parsed.data;
}

function externalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === "" ? undefined : value;
}

const TM_HOME = envOverride("TOKENMAXXING_HOME") ?? join(HOME, ".config", "tokenmaxxing");
const CLAUDE_DIR = externalEnv("CLAUDE_CONFIG_DIR") ?? join(HOME, ".claude");

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

  claudeJson: envOverride("TOKENMAXXING_CLAUDE_JSON") ?? join(HOME, ".claude.json"),
  claudeSettings: envOverride("TOKENMAXXING_CLAUDE_SETTINGS") ?? join(CLAUDE_DIR, "settings.json"),
  claudeDir: CLAUDE_DIR,

  launchdAgentsDir: envOverride("TOKENMAXXING_LAUNCHD_DIR") ?? join(HOME, "Library", "LaunchAgents"),
  systemdUserDir: envOverride("TOKENMAXXING_SYSTEMD_USER_DIR") ?? join(HOME, ".config", "systemd", "user"),
} as const;

const CODEX_HOME = envOverride("TOKENMAXXING_CODEX_HOME") ?? externalEnv("CODEX_HOME") ?? join(HOME, ".codex");

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

export function keychainNames(): { service: string; account: string } {
  const account = envOverride("TOKENMAXXING_KEYCHAIN_ACCOUNT") ?? externalEnv("USER");
  if (account === undefined) throw new Error("USER is unset - the macOS keychain account name cannot be resolved; set TOKENMAXXING_KEYCHAIN_ACCOUNT");
  return { service: envOverride("TOKENMAXXING_KEYCHAIN_SERVICE") ?? "Claude Code-credentials", account };
}

export function credItemFor(accountUuid: string): string {
  return `tokenmaxxing-cred-${accountUuid.slice(0, 8)}`;
}

export function credDir(): string {
  const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secure !== undefined) return (secure || join(HOME, ".claude")).normalize("NFC");
  return paths.claudeDir;
}

export function ambientStoreDir(): { name: string; value: string } | null {
  for (const name of ["CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"]) {
    const value = externalEnv(name);
    if (value !== undefined) return { name, value };
  }
  return null;
}

export function namespacedCredService(configDirRaw: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(configDirRaw.normalize("NFC"));
  return `Claude Code-credentials-${h.digest("hex").slice(0, 8)}`;
}

export function realClaudeBinFromEnv(): string | undefined {
  return envOverride("TOKENMAXXING_CLAUDE_BIN");
}

export function realCodexBinFromEnv(): string | undefined {
  return envOverride("TOKENMAXXING_CODEX_BIN");
}

export { HOME };
