import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage, log } from "./log.ts";
import { codexPaths, grokPaths, opencodeGoPaths, paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { RespawnMarkerSchema } from "./types.ts";

const SessionSchema = z.object({ flags: z.array(z.string()), cwd: z.string() });

const SESSION_RETENTION_MS = 30 * 24 * 3600 * 1000;

const sessionsDir = (): string => join(paths.home, "sessions");

function sessionFile(sid: string): string {
  return join(sessionsDir(), `${sid}.json`);
}

export function saveSessionFlags(sid: string, flags: string[], cwd: string): void {
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileAtomic(sessionFile(sid), JSON.stringify({ flags, cwd }));
}

export function loadSessionFlags(sid: string): string[] | null {
  const f = sessionFile(sid);
  if (!existsSync(f)) return null;
  return SessionSchema.parse(JSON.parse(readFileSync(f, "utf8"))).flags;
}

const DEAD_STATE_ENTRIES = [
  "model-usage.json",
  "accounts.json.v1-backup",
  "codex-accounts.json.v1-backup",
  "nextcheck.json",
  "usage.json",
  "lastswap.json",
  "depleted.json",
  "codex-lastswap.json",
  "creds",
  "codex-creds",
  "codex-reconcile",
  "sample",
];

const TMP_MARKER = ".tmp.";
const TMP_GRACE_MS = 3600 * 1000;

const STORE_PARENTS = [paths.storesDir, codexPaths.storesDir, grokPaths.storesDir, opencodeGoPaths.storesDir];

function listDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch (e) {
    log("state.sweep_unreadable", { dir, err: errorMessage(e) });
    return [];
  }
}

function tmpSweepDirs(): string[] {
  const dirs = [paths.home, paths.usageDir, paths.presenceDir, paths.respawnDir, sessionsDir(), codexPaths.presenceDir, codexPaths.respawnDir];
  for (const parent of STORE_PARENTS) {
    for (const child of listDir(parent)) dirs.push(join(parent, child));
  }
  return dirs;
}

function pruneDeadState(now: number): void {
  for (const name of DEAD_STATE_ENTRIES) {
    try {
      rmSync(join(paths.home, name), { recursive: true, force: true });
    } catch (e) {
      log("state.dead_entry_failed", { name, err: errorMessage(e) });
    }
  }
  for (const dir of tmpSweepDirs()) {
    for (const f of listDir(dir)) {
      if (!f.includes(TMP_MARKER)) continue;
      const p = join(dir, f);
      try {
        if (now - statSync(p).mtimeMs > TMP_GRACE_MS) rmSync(p, { force: true });
      } catch {
      }
    }
  }
}

export function pruneStaleSessions(now: number): void {
  pruneDeadState(now);
  const dir = sessionsDir();
  for (const f of listDir(dir)) {
    const p = join(dir, f);
    try {
      if (now - statSync(p).mtimeMs > SESSION_RETENTION_MS) rmSync(p, { force: true });
    } catch {
    }
  }
}

export type SupervisedSession = { sid: string; launchedAt: number | null };

const LaunchedAtSchema = z.coerce.number().finite().optional().catch(undefined);

export function supervisedSession(env: Record<string, string | undefined> = process.env): SupervisedSession | null {
  if (env.TOKENMAXXING_SUPERVISED !== "1") return null;
  const sid = env.TOKENMAXXING_SESSION_ID;
  if (sid == null || sid === "") return null;
  return { sid, launchedAt: LaunchedAtSchema.parse(env.TOKENMAXXING_LAUNCHED_AT) ?? null };
}

export function writeRespawnMarker(input: { session: SupervisedSession; sessionId: string; accountId: string; waitUntil: number; compact: boolean }): void {
  mkdirSync(paths.respawnDir, { recursive: true });
  const payload: z.infer<typeof RespawnMarkerSchema> = {
    accountId: input.accountId,
    ts: Date.now(),
    waitUntil: input.waitUntil,
    sessionId: input.sessionId,
    compact: input.compact,
    ...(input.session.launchedAt != null ? { launchedAt: input.session.launchedAt } : {}),
  };
  writeFileAtomic(join(paths.respawnDir, input.session.sid), JSON.stringify(payload));
}
