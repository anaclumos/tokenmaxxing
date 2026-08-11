// Per-session registry under $TOKENMAXXING_HOME/relay/sessions/<id>.json.
// Per-session flock only (high churn); never a global relay lock for turns.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../paths.ts";
import { writeFileAtomic } from "../atomic.ts";
import { withLock } from "../lock.ts";
import { ClaudePermissionModeSchema, type ClaudePermissionMode } from "./modes.ts";
import { loadRelayConfig, type RelayWorker } from "./config.ts";

export const RelaySessionStateSchema = z.enum([
  "idle",
  "running",
  "permission-needed",
  "destroyed",
]);
export type RelaySessionState = z.infer<typeof RelaySessionStateSchema>;

export const RelayRegistryEntrySchema = z.object({
  sessionId: z.uuid(),
  tmuxName: z.string().min(1),
  worker: z.enum(["claude", "codex"]),
  permissionMode: ClaudePermissionModeSchema,
  cwd: z.string().min(1),
  state: RelaySessionStateSchema,
  createdAt: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nonnegative(),
  pendingRequestId: z.string().min(1).optional(),
});
export type RelayRegistryEntry = z.infer<typeof RelayRegistryEntrySchema>;

export function relaySessionsDir(): string {
  return join(paths.relayDir, "sessions");
}

export function relayLocksDir(): string {
  return join(paths.relayDir, "locks");
}

export function relayTurnDoneDir(): string {
  return join(paths.relayDir, "turn-done");
}

export function relayPendingDir(): string {
  return join(paths.relayDir, "pending");
}

export function relayDecisionsDir(): string {
  return join(paths.relayDir, "decisions");
}

export function sessionEntryPath(input: { sessionId: string }): string {
  return join(relaySessionsDir(), `${input.sessionId}.json`);
}

export function sessionLockPath(input: { sessionId: string }): string {
  return join(relayLocksDir(), input.sessionId);
}

export function turnDonePath(input: { sessionId: string }): string {
  return join(relayTurnDoneDir(), input.sessionId);
}

export function pendingRequestPath(input: { sessionId: string; requestId: string }): string {
  return join(relayPendingDir(), input.sessionId, `${input.requestId}.json`);
}

export function decisionPath(input: { sessionId: string; requestId: string }): string {
  return join(relayDecisionsDir(), input.sessionId, `${input.requestId}.json`);
}

export function tmuxNameFor(input: { sessionId: string; prefix?: string }): string {
  const prefix = input.prefix ?? loadRelayConfig().sessionPrefix;
  return `${prefix}${input.sessionId}`;
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function readEntry(input: { sessionId: string }): RelayRegistryEntry | null {
  const path = sessionEntryPath(input);
  if (!existsSync(path)) return null;
  return RelayRegistryEntrySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeEntry(input: { entry: RelayRegistryEntry }): void {
  mkdirSync(relaySessionsDir(), { recursive: true });
  writeFileAtomic(sessionEntryPath({ sessionId: input.entry.sessionId }), JSON.stringify(input.entry, null, 2) + "\n");
}

export function deleteEntry(input: { sessionId: string }): void {
  rmSync(sessionEntryPath(input), { force: true });
}

export async function withSessionLock<T>(input: {
  sessionId: string;
  fn: () => Promise<T> | T;
}): Promise<T> {
  mkdirSync(relayLocksDir(), { recursive: true });
  return withLock(sessionLockPath({ sessionId: input.sessionId }), input.fn);
}

export function listEntries(): RelayRegistryEntry[] {
  const dir = relaySessionsDir();
  if (!existsSync(dir)) return [];
  const out: RelayRegistryEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      out.push(RelayRegistryEntrySchema.parse(JSON.parse(readFileSync(path, "utf8"))));
    } catch {
      // skip corrupt; gc can reap
    }
  }
  return out;
}

export function createEntry(input: {
  sessionId: string;
  worker: RelayWorker;
  permissionMode: ClaudePermissionMode;
  cwd: string;
  now?: number;
}): RelayRegistryEntry {
  const now = input.now ?? Date.now();
  const entry = RelayRegistryEntrySchema.parse({
    sessionId: input.sessionId,
    tmuxName: tmuxNameFor({ sessionId: input.sessionId }),
    worker: input.worker,
    permissionMode: input.permissionMode,
    cwd: input.cwd,
    state: "idle",
    createdAt: now,
    lastActiveAt: now,
  });
  writeEntry({ entry });
  return entry;
}

export function touchEntry(input: {
  sessionId: string;
  state?: RelaySessionState;
  permissionMode?: ClaudePermissionMode;
  pendingRequestId?: string | null;
  now?: number;
}): RelayRegistryEntry {
  const prev = readEntry({ sessionId: input.sessionId });
  if (prev == null) throw new Error(`relay session not found: ${input.sessionId}`);
  const next = RelayRegistryEntrySchema.parse({
    ...prev,
    state: input.state ?? prev.state,
    permissionMode: input.permissionMode ?? prev.permissionMode,
    lastActiveAt: input.now ?? Date.now(),
    pendingRequestId: input.pendingRequestId === null
      ? undefined
      : (input.pendingRequestId ?? prev.pendingRequestId),
  });
  writeEntry({ entry: next });
  return next;
}

/** True when a registry entry exists for this relay session id. */
export function registryHas(input: { sessionId: string }): boolean {
  return readEntry(input) != null;
}

export function entryMtimeMs(input: { sessionId: string }): number | null {
  const path = sessionEntryPath(input);
  if (!existsSync(path)) return null;
  return statSync(path).mtimeMs;
}
