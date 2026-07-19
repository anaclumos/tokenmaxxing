// Central path resolution. EVERY externally-observable path is overridable via an
// env var so the whole tool can run hermetically in tests without touching the
// user's real ~/.config, ~/.claude, or login keychain.

import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const HOME = homedir();

/** A set env override; empty or unset parses to undefined and the fallback applies. */
const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);

function env(name: string, fallback: string): string {
  return EnvOverrideSchema.parse(process.env[name]) ?? fallback;
}

/** Root of all tokenmaxxing config + state. Default ~/.config/tokenmaxxing. */
const TM_HOME = env("TOKENMAXXING_HOME", join(HOME, ".config", "tokenmaxxing"));

export const paths = {
  home: TM_HOME,
  configJson: join(TM_HOME, "config.json"),
  accountsJson: join(TM_HOME, "accounts.json"),
  usageJson: join(TM_HOME, "usage.json"),
  modelUsageJson: join(TM_HOME, "model-usage.json"),
  lastSwapJson: join(TM_HOME, "lastswap.json"),
  /** the last depleted-wait decision, replayed to sibling hooks (self-expiring). */
  depletedJson: join(TM_HOME, "depleted.json"),
  respawnDir: join(TM_HOME, "respawn"),
  binDir: join(TM_HOME, "bin"),
  supervisorLink: join(TM_HOME, "bin", "claude"),
  lockFile: join(TM_HOME, "lock"),
  logFile: join(TM_HOME, "tokenmaxxing.log"),
  onboardDir: join(TM_HOME, "onboard"),
  sampleDir: join(TM_HOME, "sample"),
  /** linux only: parked credential .json files (0700 dir, 0600 files). */
  credsDir: join(TM_HOME, "creds"),

  /** `xx serve` slack bridge: tokens + channel->repo links (0600: holds the
   *  xoxb-/xapp- tokens), per-thread claude session records, and the
   *  single-instance flock (a new daemon generation blocks on it until the
   *  previous one - possibly still draining an in-flight turn - fully exits,
   *  so two generations never act on the same thread records or cwd). */
  slackJson: join(TM_HOME, "slack.json"),
  slackThreadsDir: join(TM_HOME, "slack-threads"),
  serveLockFile: join(TM_HOME, "serve-lock"),

  /** ~/.claude.json - holds the active `oauthAccount` identity object. */
  claudeJson: env("TOKENMAXXING_CLAUDE_JSON", join(HOME, ".claude.json")),
  /** ~/.claude/settings.json - user-owned; we merge three entries into it. */
  claudeSettings: env(
    "TOKENMAXXING_CLAUDE_SETTINGS",
    join(env("CLAUDE_CONFIG_DIR", join(HOME, ".claude")), "settings.json"),
  ),
  /** ~/.claude - claude's config dir (settings.json, projects/ transcripts;
   *  credDir() falls back to it). */
  claudeDir: env("CLAUDE_CONFIG_DIR", join(HOME, ".claude")),

  /** where the periodic-check timer units live (launchd / systemd user). */
  launchdAgentsDir: env("TOKENMAXXING_LAUNCHD_DIR", join(HOME, "Library", "LaunchAgents")),
  systemdUserDir: env("TOKENMAXXING_SYSTEMD_USER_DIR", join(HOME, ".config", "systemd", "user")),
} as const;

/** Codex home: where the live auth.json lives. Test override first, then
 *  codex's own CODEX_HOME env, then its default ~/.codex. */
const CODEX_HOME = env("TOKENMAXXING_CODEX_HOME", env("CODEX_HOME", join(HOME, ".codex")));

export const codexPaths = {
  home: CODEX_HOME,
  /** the live credential file (codex file-mode store; verified 0.144.4/5). */
  authJson: join(CODEX_HOME, "auth.json"),
  /** user-level hook declarations codex reads (verified against the binary + docs). */
  hooksJson: join(CODEX_HOME, "hooks.json"),
  /** tokenmaxxing's codex pool state, parallel to the claude files in TM_HOME. */
  accountsJson: join(TM_HOME, "codex-accounts.json"),
  lastSwapJson: join(TM_HOME, "codex-lastswap.json"),
  lockFile: join(TM_HOME, "codex-lock"),
  /** parked auth.json blobs: 0600 files on BOTH platforms (codex's own store is
   *  a plaintext file, and parked blobs at ~6KB would risk the security(1)
   *  write-size trap that once truncated a 4.3KB claude blob). */
  credsDir: join(TM_HOME, "codex-creds"),
  onboardDir: join(TM_HOME, "codex-onboard"),
  respawnDir: join(TM_HOME, "codex-respawn"),
  /** one file per RUNNING supervised codex session: {accountId, pid, ts}. A
   *  running account's parked token must never be refreshed or targeted (its
   *  live rotations supersede the parked copy, and reuse is punished). */
  presenceDir: join(TM_HOME, "codex-live"),
} as const;

/** Per-account parked codex credential file name: tokenmaxxing-codex-<id8>. */
export function codexCredItemFor(accountId: string): string {
  return `tokenmaxxing-codex-${accountId.slice(0, 8)}`;
}

/** The macOS login-keychain generic-password the live `claude` reads. */
export const keychain = {
  service: env("TOKENMAXXING_KEYCHAIN_SERVICE", "Claude Code-credentials"),
  account: env("TOKENMAXXING_KEYCHAIN_ACCOUNT", process.env.USER ?? "unknown"),
} as const;

/** Per-account parked credential item name: tokenmaxxing-cred-<accountUuid[:8]>. */
export function credItemFor(accountUuid: string): string {
  return `tokenmaxxing-cred-${accountUuid.slice(0, 8)}`;
}

/**
 * The dir whose `.credentials.json` is claude's live credential on linux -
 * mirrors claude's own resolution (verified 2.1.205 `Wde()`): the
 * CLAUDE_SECURESTORAGE_CONFIG_DIR override is checked FIRST when defined
 * (defined-but-empty falls to ~/.claude, NFC-normalized), else the config dir.
 */
export function credDir(): string {
  const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secure !== undefined) return (secure || join(HOME, ".claude")).normalize("NFC");
  return paths.claudeDir;
}

/**
 * The keychain service claude uses when CLAUDE_CONFIG_DIR is set:
 * `Claude Code-credentials-<first 8 hex of sha256(NFC(raw dir string))>`.
 * Hash is over the RAW string, so the dir must be byte-stable.
 */
export function namespacedCredService(configDirRaw: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(configDirRaw.normalize("NFC"));
  return `Claude Code-credentials-${h.digest("hex").slice(0, 8)}`;
}

/** Resolve the REAL claude binary (never our shim). Order: explicit env, config, PATH scan. */
export function realClaudeBinFromEnv(): string | undefined {
  return EnvOverrideSchema.parse(process.env.TOKENMAXXING_CLAUDE_BIN);
}

/** Same override hook for the real codex binary (tests / relocation). */
export function realCodexBinFromEnv(): string | undefined {
  return EnvOverrideSchema.parse(process.env.TOKENMAXXING_CODEX_BIN);
}

export { HOME };
