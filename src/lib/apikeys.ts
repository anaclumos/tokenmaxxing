import { chmodSync, closeSync, existsSync, mkdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { countBy, isEqual, sortBy } from "es-toolkit";
import { writeFileAtomic } from "./atomic.ts";
import { withLock } from "./lock.ts";
import { claudePool, optionalEnv, paths } from "./paths.ts";
import { livingPresences } from "./presence.ts";
import type { ApiKeyPool } from "./provider.ts";
import { readJsonFile } from "./state.ts";
import { ApiKeysIndexSchema, SessionCostSchema, type ApiKey, type ApiKeysIndex, type SessionCost } from "./types.ts";

export const API_KEY_ENV = "TOKENMAXXING_API_KEY_ID";
export const API_KEY_FD = 3;

export function apiKeyEnv(env: Record<string, string | undefined>, key: ApiKey): Record<string, string | undefined> {
  const header = key.workspaceId == null ? null : `anthropic-workspace-id: ${key.workspaceId}`;
  const headers = header == null ? env.ANTHROPIC_CUSTOM_HEADERS : env.ANTHROPIC_CUSTOM_HEADERS ? `${env.ANTHROPIC_CUSTOM_HEADERS}\n${header}` : header;
  return { ...env, CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: String(API_KEY_FD), ...(headers != null ? { ANTHROPIC_CUSTOM_HEADERS: headers } : {}) };
}

export function readApiKey(key: ApiKey): string {
  return `${readFileSync(apiKeySecretFor(key.id), "utf8").trim()}\n`;
}

export function sendApiKey(child: { stdio: readonly (number | null)[] }, secret: string): void {
  const fd = child.stdio[API_KEY_FD];
  if (fd == null) throw new Error(`the child has no descriptor ${API_KEY_FD} to receive the API key`);
  try {
    const written = writeSync(fd, secret);
    if (written !== Buffer.byteLength(secret)) throw new Error(`wrote ${written} of ${Buffer.byteLength(secret)} bytes of the API key to descriptor ${API_KEY_FD}`);
  } finally {
    closeSync(fd);
  }
}

export function apiKeySecretFor(id: string): string {
  return join(paths.apiKeysDir, id);
}

export function loadApiKeys(): ApiKeysIndex {
  if (!existsSync(claudePool.apiKeysJson)) return { version: 1, keys: [], baselines: {} };
  return readJsonFile(claudePool.apiKeysJson, ApiKeysIndexSchema);
}

export function saveApiKeys(idx: ApiKeysIndex): void {
  writeFileAtomic(claudePool.apiKeysJson, JSON.stringify(ApiKeysIndexSchema.parse(idx), null, 2) + "\n");
}

export function writeApiKeySecret(id: string, secret: string): void {
  mkdirSync(paths.apiKeysDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.apiKeysDir, 0o700);
  writeFileAtomic(apiKeySecretFor(id), secret);
}

export function removeApiKeySecret(id: string): void {
  rmSync(apiKeySecretFor(id), { force: true });
}

export function creditLeft(k: ApiKey): number | null {
  return k.creditUsd == null ? null : k.creditUsd - k.spentUsd;
}

export function keyUsable(k: ApiKey): boolean {
  const left = creditLeft(k);
  return k.refusedAt == null && (left == null || left > 0);
}

export function keySessions(): Map<string, number> {
  const ids = livingPresences(paths.presenceDir).flatMap((p) => (p.apiKeyId == null ? [] : [p.apiKeyId]));
  return new Map(Object.entries(countBy(ids, (id) => id)));
}

export function pickApiKey(keys: ApiKey[], sessions: Map<string, number>, exclude: string[]): ApiKey | null {
  const candidates = keys.filter((k) => keyUsable(k) && !exclude.includes(k.id));
  return sortBy(candidates, [(k) => (creditLeft(k) == null ? 1 : 0), (k) => -(creditLeft(k) ?? 0), (k) => sessions.get(k.id) ?? 0, (k) => k.addedAt])[0] ?? null;
}

function availableKeys(): ApiKey[] {
  return loadApiKeys().keys.filter((k) => existsSync(apiKeySecretFor(k.id)));
}

export function usableApiKey(id: string): ApiKey | null {
  const key = availableKeys().find((k) => k.id === id);
  return key != null && keyUsable(key) ? key : null;
}

export function launchApiKey(): ApiKey | null {
  return pickApiKey(availableKeys(), keySessions(), []);
}

export function liveApiKeyId(env: Record<string, string | undefined> = process.env): string | null {
  return optionalEnv(API_KEY_ENV, env) ?? null;
}

export const claudeApiKeys: ApiKeyPool = {
  liveId: () => liveApiKeyId(),
  holds: (id) => usableApiKey(id) != null,
  pick: (exclude) => pickApiKey(availableKeys(), keySessions(), exclude),
};

export async function refuseApiKey(id: string, now: number): Promise<boolean> {
  return withLock(claudePool.lockFile, () => {
    const idx = loadApiKeys();
    const key = idx.keys.find((k) => k.id === id);
    if (!key) return false;
    key.refusedAt = now;
    saveApiKeys(idx);
    return true;
  });
}

const costFileFor = (sid: string): string => join(paths.costDir, `${sid}.json`);

export function writeSessionCost(sid: string, cost: SessionCost): void {
  const file = costFileFor(sid);
  if (existsSync(file) && isEqual(readJsonFile(file, SessionCostSchema), cost)) return;
  writeFileAtomic(file, JSON.stringify(cost));
}

export function clearSessionCost(sid: string): void {
  rmSync(costFileFor(sid), { force: true });
}

export async function foldCompactionCost(sid: string, cost: SessionCost, keyId: string | null, restoredCost: (id: string) => number): Promise<void> {
  if (!existsSync(claudePool.apiKeysJson)) return;
  writeSessionCost(sid, cost);
  await foldSessionCost(sid, keyId, (id) => (id === cost.sessionId ? cost.usd : restoredCost(id)));
}

const BASELINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function settleLiveSessionCosts(idx: ApiKeysIndex, keyId: string): void {
  const now = Date.now();
  for (const p of livingPresences(paths.presenceDir)) {
    const file = costFileFor(p.id);
    if (p.apiKeyId !== keyId || !existsSync(file)) continue;
    const seen = readJsonFile(file, SessionCostSchema);
    idx.baselines[seen.sessionId] = { usd: seen.usd, at: now };
  }
}

export async function foldSessionCost(sid: string, keyId: string | null, restoredCost: (id: string) => number): Promise<void> {
  const file = costFileFor(sid);
  if (!existsSync(file) || !existsSync(claudePool.apiKeysJson)) return;
  await withLock(claudePool.lockFile, () => {
    const seen = readJsonFile(file, SessionCostSchema);
    const idx = loadApiKeys();
    const prev = idx.baselines[seen.sessionId];
    if (prev?.usd === seen.usd) return;
    const delta = Math.max(0, seen.usd - (prev?.usd ?? restoredCost(seen.sessionId)));
    const key = keyId == null ? undefined : idx.keys.find((k) => k.id === keyId);
    if (key) key.spentUsd += delta;
    const now = Date.now();
    idx.baselines = Object.fromEntries(Object.entries(idx.baselines).filter(([, b]) => now - b.at <= BASELINE_RETENTION_MS));
    idx.baselines[seen.sessionId] = { usd: seen.usd, at: now };
    saveApiKeys(idx);
  });
}
