import { closeSync, fstatSync, openSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { isEqual } from "es-toolkit";
import { z } from "zod";
import { paths, realClaudeBinFromEnv, realCodexBinFromEnv } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { errnoCode } from "./errors.ts";
import { parseJson, readJson, tryReadJson } from "./json.ts";
import {
  AccountsIndexSchema,
  ConfigSchema,
  LastSwapSchema,
  ModelUsageStateSchema,
  NextCheckSchema,
  UsageStateSchema,
  type Account,
  type AccountsIndex,
  type Config,
  type ModelUsageState,
  type OAuthAccount,
  type OAuthCreds,
  type UsageState,
} from "./types.ts";
import type { FullUsage } from "./usage.ts";

const RawConfigSchema = z.record(z.string(), z.unknown());

export function loadConfig(): Config {
  const cfg = readJson(paths.configJson, ConfigSchema) ?? ConfigSchema.parse({});
  return { ...cfg, claudeBin: realClaudeBinFromEnv() ?? cfg.claudeBin, codexBin: realCodexBinFromEnv() ?? cfg.codexBin };
}

export function pinBinOverride(input: { key: "claudeBin" | "codexBin"; bin: string }): void {
  const raw = readJson(paths.configJson, RawConfigSchema) ?? {};
  raw[input.key] = input.bin;
  writeFileAtomic(paths.configJson, JSON.stringify(raw, null, 2) + "\n");
}

const emptyIndex = (): AccountsIndex => ({ version: 1, activeAccountUuid: null, accounts: [] });

export function loadAccounts(): AccountsIndex {
  return readJson(paths.accountsJson, AccountsIndexSchema) ?? emptyIndex();
}

export function saveAccounts(idx: AccountsIndex): void {
  writeFileAtomic(paths.accountsJson, JSON.stringify(idx, null, 2) + "\n");
}

export function upsertAccount(idx: AccountsIndex, fresh: Account): void {
  const existing = idx.accounts.find((a) => a.accountUuid === fresh.accountUuid);
  if (existing) Object.assign(existing, fresh);
  else idx.accounts.push(fresh);
}

export function importedAccount(input: {
  existing: Account | undefined;
  oauthAccount: OAuthAccount;
  keychainItem: string;
  creds: OAuthCreds;
  sampled: FullUsage | null;
}): Account {
  const { existing, oauthAccount, keychainItem, creds, sampled } = input;
  const now = Date.now();
  const perModelSampled = sampled != null && Object.keys(sampled.perModel).length > 0;
  return {
    accountUuid: oauthAccount.accountUuid,
    email: oauthAccount.emailAddress,
    organizationUuid: oauthAccount.organizationUuid,
    label: existing?.label ?? oauthAccount.emailAddress,
    keychainItem,
    oauthAccount,
    addedAt: existing?.addedAt ?? new Date(now).toISOString(),
    subscriptionType: creds.subscriptionType,
    rateLimitTier: creds.rateLimitTier,
    needsReauth: false,
    lastUsage: sampled ? { fiveHour: sampled.session, sevenDay: sampled.weekAll } : existing?.lastUsage,
    lastPerModel: perModelSampled ? sampled.perModel : existing?.lastPerModel,
    lastPerModelAt: perModelSampled ? now : existing?.lastPerModelAt,
    lastUsageAt: sampled ? now : existing?.lastUsageAt,
  };
}

export function loadUsageSnapshot(): { state: UsageState; at: number } | null {
  let fd: number;
  try {
    fd = openSync(paths.usageJson, "r");
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return null;
    throw e;
  }
  try {
    return { state: parseJson(UsageStateSchema, readFileSync(fd, "utf8"), paths.usageJson), at: fstatSync(fd).mtimeMs };
  } finally {
    closeSync(fd);
  }
}

export function loadUsage(): UsageState | null {
  return loadUsageSnapshot()?.state ?? null;
}

export function clearUsageSnapshots(): void {
  rmSync(paths.usageJson, { force: true });
  rmSync(paths.modelUsageJson, { force: true });
}

export function loadLastSwapAt(): number | null {
  return readJson(paths.lastSwapJson, LastSwapSchema)?.ts ?? null;
}

export function saveLastSwapAt(ts: number): void {
  writeFileAtomic(paths.lastSwapJson, JSON.stringify({ ts }));
}

const DepletedWaitSchema = z.object({ waitUntil: z.number(), accountUuid: z.string(), ts: z.number() });
export type DepletedWait = z.infer<typeof DepletedWaitSchema>;

export function loadDepletedWait(): DepletedWait | null {
  return readJson(paths.depletedJson, DepletedWaitSchema);
}

export function saveDepletedWait(rec: DepletedWait): void {
  writeFileAtomic(paths.depletedJson, JSON.stringify(rec));
}

export function clearDepletedWait(): void {
  rmSync(paths.depletedJson, { force: true });
}

export const MAX_CHECK_DELAY_TICKS = 5;
export const POST_SWAP_COOLDOWN_MS = 45_000;

export function maxCheckDelayMs(cfg: Config): number {
  return MAX_CHECK_DELAY_TICKS * cfg.policy.checkIntervalMs;
}

export function loadNextCheckDueAt(input: { now: number; cfg: Config }): number | null {
  const parsed = tryReadJson(paths.nextCheckJson, NextCheckSchema);
  if (!parsed) return null;
  return parsed.dueAt - input.now > Math.max(maxCheckDelayMs(input.cfg), POST_SWAP_COOLDOWN_MS) ? null : parsed.dueAt;
}

export function saveNextCheckDueAt(input: { dueAt: number; ts: number }): void {
  writeFileAtomic(paths.nextCheckJson, JSON.stringify(input));
}

export function clearNextCheck(): void {
  rmSync(paths.nextCheckJson, { force: true });
}

const USAGE_TS_REFRESH_MS = 10 * 60_000;

export function writeUsage(next: UsageState): boolean {
  const prev = loadUsage();
  if (prev && isEqual({ ...prev, ts: 0 }, { ...next, ts: 0 }) && next.ts - prev.ts < USAGE_TS_REFRESH_MS) {
    try {
      utimesSync(paths.usageJson, new Date(next.ts), new Date(next.ts));
    } catch (e) {
      if (errnoCode(e) !== "ENOENT") throw e;
    }
    return false;
  }
  writeFileAtomic(paths.usageJson, JSON.stringify(next));
  return true;
}

export function loadModelUsage(): ModelUsageState | null {
  return readJson(paths.modelUsageJson, ModelUsageStateSchema);
}

export function saveModelUsage(next: ModelUsageState): void {
  writeFileAtomic(paths.modelUsageJson, JSON.stringify(next));
}
