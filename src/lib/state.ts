import { closeSync, existsSync, fstatSync, openSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { isEqual } from "es-toolkit";
import { z } from "zod";
import { claudePool, optionalEnv, paths, usageJsonFor, type PoolPaths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import {
  AccountsIndexSchema,
  ConfigSchema,
  ErrnoSchema,
  UsageStateSchema,
  WaitQueueSchema,
  type Account,
  type AccountsIndex,
  type Config,
  type UsageState,
  type WaitClaim,
  type Window,
} from "./types.ts";

export function loadConfig(): Config {
  let raw: unknown = {};
  if (existsSync(paths.configJson)) {
    try {
      raw = JSON.parse(readFileSync(paths.configJson, "utf8"));
    } catch {
      throw new Error(`${paths.configJson} is corrupt (unparsable JSON) - fix or remove it`);
    }
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ");
    throw new Error(`${paths.configJson} is invalid (${fields}) - fix or remove the offending values`);
  }
  const cfg = parsed.data;
  cfg.claudeBin = optionalEnv("TOKENMAXXING_CLAUDE_BIN") ?? cfg.claudeBin;
  cfg.codexBin = optionalEnv("TOKENMAXXING_CODEX_BIN") ?? cfg.codexBin;
  cfg.grokBin = optionalEnv("TOKENMAXXING_GROK_BIN") ?? cfg.grokBin;
  cfg.opencodeBin = optionalEnv("TOKENMAXXING_OPENCODE_BIN") ?? cfg.opencodeBin;
  return cfg;
}

export function pinBinOverride(input: { key: "claudeBin" | "codexBin" | "grokBin" | "opencodeBin"; bin: string }): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(paths.configJson)) {
    raw = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(paths.configJson, "utf8")));
  }
  raw[input.key] = input.bin;
  writeFileAtomic(paths.configJson, JSON.stringify(raw, null, 2) + "\n");
}

const emptyIndex = (): AccountsIndex => ({ version: 2, accounts: [] });

export function loadAccounts(pool: PoolPaths): AccountsIndex {
  if (!existsSync(pool.accountsJson)) return emptyIndex();
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(pool.accountsJson, "utf8"));
  } catch {
    throw new Error(`${pool.accountsJson} is corrupt (unparsable JSON) - refusing to treat a damaged pool as empty; repair or remove the file`);
  }
  const parsed = AccountsIndexSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${pool.accountsJson} does not match the accounts schema - refusing to treat a damaged pool as empty; repair or remove the file`);
  }
  return parsed.data;
}

export function saveAccounts(pool: PoolPaths, idx: AccountsIndex): void {
  writeFileAtomic(pool.accountsJson, JSON.stringify(AccountsIndexSchema.parse(idx), null, 2) + "\n");
}

function loadWaitQueue(): WaitClaim[] {
  if (!existsSync(claudePool.waitQueueJson)) return [];
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(claudePool.waitQueueJson, "utf8"));
  } catch {
    throw new Error(`${claudePool.waitQueueJson} is corrupt (unparsable JSON) - refusing to treat a damaged wait queue as empty; repair or remove the file`);
  }
  const parsed = WaitQueueSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${claudePool.waitQueueJson} does not match the wait-queue schema - refusing to treat a damaged wait queue as empty; repair or remove the file`);
  }
  return parsed.data.claims;
}

function saveWaitQueue(claims: WaitClaim[]): void {
  writeFileAtomic(claudePool.waitQueueJson, JSON.stringify(WaitQueueSchema.parse({ version: 1, claims }), null, 2) + "\n");
}

export function liveWaitClaims(now: number): WaitClaim[] {
  return loadWaitQueue().filter((c) => c.waitUntil > now);
}

export function replaceWaitClaim(claim: WaitClaim): void {
  saveWaitQueue([...liveWaitClaims(Date.now()).filter((c) => c.sessionId !== claim.sessionId), claim]);
}

export function releaseWaitClaim(sessionId: string): void {
  const now = Date.now();
  const raw = loadWaitQueue();
  const next = raw.filter((c) => c.waitUntil > now && c.sessionId !== sessionId);
  if (next.length === raw.length) return;
  saveWaitQueue(next);
}

export type Harvest = {
  id: string;
  email: string | null;
  tier: string | null;
  oauthAccount?: Account["oauthAccount"];
  sample: { windows: Window[]; at: number } | null;
  usageRetryAt?: number;
  park: () => Promise<void>;
};

export function upsertAccount(
  idx: AccountsIndex,
  h: Harvest,
  mergeWindows: (next: Window[], prev: Window[]) => Window[],
): Account {
  const existing = idx.accounts.find((a) => a.id === h.id);
  const fresh: Account = {
    id: h.id,
    label: existing?.label ?? h.email ?? h.id.slice(0, 8),
    email: h.email,
    tier: h.tier,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    windows: h.sample ? mergeWindows(h.sample.windows, existing?.windows ?? []) : (existing?.windows ?? []),
    lastUsageAt: h.sample ? h.sample.at : existing?.lastUsageAt,
    needsReauth: false,
    ...(h.oauthAccount ? { oauthAccount: h.oauthAccount } : {}),
    usageRetryAt: h.sample ? undefined : (h.usageRetryAt ?? existing?.usageRetryAt),
  };
  if (existing) Object.assign(existing, fresh);
  else idx.accounts.push(fresh);
  return existing ?? fresh;
}

export type UsageSnapshot = { state: UsageState; at: number };

export function loadUsageSnapshot(accountId: string): UsageSnapshot | null {
  let fd: number;
  try {
    fd = openSync(usageJsonFor(accountId), "r");
  } catch {
    return null;
  }
  try {
    const at = fstatSync(fd).mtimeMs;
    const parsed = UsageStateSchema.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    return parsed.success && parsed.data.account === accountId ? { state: parsed.data, at } : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function clearUsageSnapshot(accountId: string): void {
  rmSync(usageJsonFor(accountId), { force: true });
}

const USAGE_TS_REFRESH_MS = 10 * 60_000;
const SAMPLED_AT_REFRESH_MS = 30_000;

export function writeUsage(input: UsageState): boolean {
  const file = usageJsonFor(input.account);
  const prev = loadUsageSnapshot(input.account)?.state ?? null;
  const next: UsageState = { ...input, sampledAt: input.ts };
  if (
    prev &&
    isEqual({ ...prev, ts: 0, sampledAt: 0 }, { ...next, ts: 0, sampledAt: 0 }) &&
    next.ts - prev.ts < USAGE_TS_REFRESH_MS &&
    next.ts - (prev.sampledAt ?? prev.ts) < SAMPLED_AT_REFRESH_MS
  ) {
    try {
      utimesSync(file, new Date(next.ts), new Date(next.ts));
    } catch (e) {
      if (ErrnoSchema.safeParse(e).data?.code !== "ENOENT") throw e;
    }
    return false;
  }
  writeFileAtomic(file, JSON.stringify(next));
  return true;
}
