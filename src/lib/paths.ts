import { homedir, userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

const HOME = homedir();

const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);

export function optionalEnv(name: string, source: Record<string, string | undefined> = process.env): string | undefined {
  return EnvOverrideSchema.parse(source[name]);
}

export function env(name: string, fallback: string): string {
  return optionalEnv(name) ?? fallback;
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
  storesDir: join(TM_HOME, "stores"),
  hubKeyFile: join(TM_HOME, "hub-key"),
  apiKeysDir: join(TM_HOME, "api-keys"),
  costDir: join(TM_HOME, "cost"),

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
  lockFile: join(TM_HOME, "lock"),
  waitQueueJson: join(TM_HOME, "wait-queue.json"),
  apiKeysJson: join(TM_HOME, "api-keys.json"),
} as const;

export const codexPool = {
  accountsJson: join(TM_HOME, "codex-accounts.json"),
  lockFile: join(TM_HOME, "codex-lock"),
} as const;

export const grokPool = {
  accountsJson: join(TM_HOME, "grok-accounts.json"),
  lockFile: join(TM_HOME, "grok-lock"),
} as const;

export const musePool = {
  accountsJson: join(TM_HOME, "muse-accounts.json"),
  lockFile: join(TM_HOME, "muse-lock"),
} as const;

export const cursorPool = {
  accountsJson: join(TM_HOME, "cursor-accounts.json"),
  lockFile: join(TM_HOME, "cursor-lock"),
} as const;

export const kimiPool = {
  accountsJson: join(TM_HOME, "kimi-accounts.json"),
  lockFile: join(TM_HOME, "kimi-lock"),
} as const;

export type PoolPaths = { accountsJson: string; lockFile: string };

const CODEX_HOME = env("TOKENMAXXING_CODEX_HOME", env("CODEX_HOME", join(HOME, ".codex")));

export const codexPaths = {
  home: CODEX_HOME,
  authJson: join(CODEX_HOME, "auth.json"),
  hooksJson: join(CODEX_HOME, "hooks.json"),
  storesDir: join(TM_HOME, "codex-stores"),
  respawnDir: join(TM_HOME, "codex-respawn"),
  presenceDir: join(TM_HOME, "codex-live"),
} as const;

export function codexStoreDirFor(accountId: string): string {
  return join(codexPaths.storesDir, shortId(accountId));
}

export function codexAuthJsonFor(accountId: string): string {
  return join(codexStoreDirFor(accountId), "auth.json");
}

export function codexSeatFromEnv(accountIds: string[], env: Record<string, string | undefined> = process.env): string | null {
  const home = env.CODEX_HOME;
  if (home == null || home === "") return null;
  return accountIds.find((id) => codexStoreDirFor(id) === home) ?? null;
}

export type PiPool = "claude" | "codex";

export function expandTilde(p: string): string {
  return p === "~" ? HOME : p.startsWith("~/") ? join(HOME, p.slice(2)) : p;
}

export const piPaths = {
  home: resolve(expandTilde(env("PI_CODING_AGENT_DIR", join(HOME, ".pi", "agent")))),
  storesDir: join(TM_HOME, "pi-stores"),
} as const;

export function piStoreDirFor(pool: PiPool, accountId: string): string {
  return join(piPaths.storesDir, pool, shortId(accountId));
}

export function piAuthJsonFor(pool: PiPool, accountId: string): string {
  return join(piStoreDirFor(pool, accountId), "auth.json");
}

const GROK_HOME_DEFAULT = join(HOME, ".grok");

export const grokPaths = {
  home: env("GROK_HOME", GROK_HOME_DEFAULT),
  storesDir: join(TM_HOME, "grok-stores"),
} as const;

export function grokStoreDirFor(accountId: string): string {
  return join(grokPaths.storesDir, shortId(accountId));
}

export function grokAuthJsonFor(accountId: string): string {
  return join(grokStoreDirFor(accountId), "auth.json");
}

const MUSE_STORES_DIR = join(TM_HOME, "muse-stores");
const XDG_CONFIG = optionalEnv("XDG_CONFIG_HOME");
export const MUSE_CONFIG_HOME_ENV = "TOKENMAXXING_XDG_CONFIG_HOME";

export function inMuseStores(path: string): boolean {
  return path === MUSE_STORES_DIR || path.startsWith(MUSE_STORES_DIR + sep);
}

// Inside a seat XDG_CONFIG_HOME names a store, and the seat carries the real config home it mirrors in
// MUSE_CONFIG_HOME_ENV; a store named with no such record (one rm --muse kept) falls back to ~/.config.
const MUSE_CONFIG_HOME =
  XDG_CONFIG == null ? join(HOME, ".config") : !inMuseStores(XDG_CONFIG) ? XDG_CONFIG : (optionalEnv(MUSE_CONFIG_HOME_ENV) ?? join(HOME, ".config"));

export const musePaths = {
  configHome: MUSE_CONFIG_HOME,
  authJson: join(MUSE_CONFIG_HOME, "muse", "auth.json"),
  sessionsDir: join(env("XDG_DATA_HOME", join(HOME, ".local", "share")), "muse", "sessions"),
  storesDir: MUSE_STORES_DIR,
  presenceDir: join(TM_HOME, "muse-live"),
} as const;

// A store is the XDG_CONFIG_HOME of the sessions seated on its account: Muse Code reads its login only from
// $XDG_CONFIG_HOME/muse/auth.json.
export function museStoreDirFor(accountId: string): string {
  return join(musePaths.storesDir, shortId(accountId));
}

export function museAuthJsonFor(accountId: string): string {
  return join(museStoreDirFor(accountId), "muse", "auth.json");
}

export function museSeatFromEnv(accountIds: string[], env: Record<string, string | undefined> = process.env): string | null {
  const home = env.XDG_CONFIG_HOME;
  if (home == null || home === "") return null;
  return accountIds.find((id) => museStoreDirFor(id) === home) ?? null;
}

export const cursorPaths = {
  authJson: join(env("XDG_CONFIG_HOME", join(HOME, ".config")), "cursor", "auth.json"),
  storesDir: join(TM_HOME, "cursor-stores"),
} as const;

export function cursorStoreDirFor(accountId: string): string {
  return join(cursorPaths.storesDir, shortId(accountId));
}

export function cursorAuthJsonFor(accountId: string): string {
  return join(cursorStoreDirFor(accountId), "auth.json");
}

export const kimiPaths = {
  home: env("KIMI_CODE_HOME", join(HOME, ".kimi-code")),
  storesDir: join(TM_HOME, "kimi-stores"),
} as const;

export function kimiStoreDirFor(accountId: string): string {
  return join(kimiPaths.storesDir, shortId(accountId));
}

export function kimiConfigFor(accountId: string): string {
  return join(kimiStoreDirFor(accountId), "config.toml");
}

export function grokSeatFromEnv(accountIds: string[], env: Record<string, string | undefined> = process.env): string | null {
  const home = env.GROK_HOME;
  if (home == null || home === "") return null;
  return accountIds.find((id) => grokStoreDirFor(id) === home) ?? null;
}

const CLAUDE_KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;

function claudeKeychainAccount(): string {
  let name: string;
  try {
    name = process.env.USER || userInfo().username;
  } catch {
    return "claude-code-user";
  }
  return CLAUDE_KEYCHAIN_ACCOUNT_PATTERN.test(name) ? name : "claude-code-user";
}

export const keychain = {
  account: optionalEnv("TOKENMAXXING_KEYCHAIN_ACCOUNT") ?? claudeKeychainAccount(),
} as const;

export function shortId(accountId: string): string {
  return accountId.slice(0, 8);
}

export function storeDirFor(accountId: string): string {
  return join(paths.storesDir, shortId(accountId));
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

export { HOME };
