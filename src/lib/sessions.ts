import { existsSync, readdirSync, realpathSync, rmSync, statSync, type Dirent } from "node:fs";
import { basename, join, sep } from "node:path";
import { z } from "zod";
import { errorMessage, log } from "./log.ts";
import { codexPaths, grokPaths, opencodeGoPaths, paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { presencePid } from "./presence.ts";
import { readJsonFile } from "./state.ts";
import { spawnedThroughShellsBy } from "./proc.ts";
import type { RespawnMarkerSchema } from "./types.ts";

const SessionSchema = z.object({ flags: z.array(z.string()), cwd: z.string(), current: z.uuid().optional() });

const SESSION_RETENTION_MS = 30 * 24 * 3600 * 1000;

const sessionsDir = (): string => join(paths.home, "sessions");

function sessionFile(sid: string): string {
  return join(sessionsDir(), `${sid}.json`);
}

export function saveSessionFlags(sid: string, flags: string[], cwd: string): void {
  writeFileAtomic(sessionFile(sid), JSON.stringify({ flags, cwd }));
}

function loadSession(sid: string): z.infer<typeof SessionSchema> | null {
  const f = sessionFile(sid);
  if (!existsSync(f)) return null;
  return readJsonFile(f, SessionSchema);
}

export function loadSessionFlags(sid: string): string[] | null {
  return loadSession(sid)?.flags ?? null;
}

export function liveSessionId(sid: string): string {
  return loadSession(sid)?.current ?? sid;
}

function recordLiveSession(sid: string, current: string): void {
  const session = loadSession(sid);
  writeFileAtomic(sessionFile(sid), JSON.stringify({ flags: session?.flags ?? [], cwd: session?.cwd ?? process.cwd(), current }));
}

const TMP_MARKER = ".tmp.";
const TMP_GRACE_MS = 3600 * 1000;

const STORE_PARENTS = [paths.storesDir, codexPaths.storesDir, grokPaths.storesDir, opencodeGoPaths.storesDir];

function listDir(dir: string, root: string): Dirent[] {
  if (!existsSync(dir)) return [];
  try {
    const resolved = realpathSync(dir);
    if (resolved !== root && !resolved.startsWith(root + sep)) return [];
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    log("state.sweep_unreadable", { dir, err: errorMessage(e) });
    return [];
  }
}

function tmpSweepDirs(root: string): string[] {
  const dirs = [paths.home, paths.usageDir, paths.presenceDir, paths.respawnDir, sessionsDir(), paths.binDir, codexPaths.presenceDir, codexPaths.respawnDir, codexPaths.onboardDir];
  for (const parent of STORE_PARENTS) {
    for (const child of listDir(parent, root)) {
      if (child.isDirectory()) dirs.push(join(parent, child.name));
    }
  }
  return dirs;
}

function pruneTmpFiles(now: number, root: string): void {
  for (const dir of tmpSweepDirs(root)) {
    for (const f of listDir(dir, root)) {
      if (!f.isFile() || !f.name.includes(TMP_MARKER)) continue;
      const p = join(dir, f.name);
      try {
        if (now - statSync(p).mtimeMs > TMP_GRACE_MS) rmSync(p, { force: true });
      } catch {
      }
    }
  }
}

export function pruneStaleSessions(now: number): void {
  let root: string;
  try {
    root = realpathSync(paths.home);
  } catch {
    return;
  }
  pruneTmpFiles(now, root);
  const dir = sessionsDir();
  for (const f of listDir(dir, root)) {
    const p = join(dir, f.name);
    try {
      if (existsSync(join(paths.presenceDir, basename(f.name, ".json")))) continue;
      if (now - statSync(p).mtimeMs > SESSION_RETENTION_MS) rmSync(p, { force: true });
    } catch {
    }
  }
}

export type SupervisedSession = { sid: string; launchedAt: number | null; live: string };

const LaunchedAtSchema = z.coerce.number().finite().optional().catch(undefined);

export function supervisedSession(env: Record<string, string | undefined> = process.env): SupervisedSession | null {
  if (env.TOKENMAXXING_SUPERVISED !== "1") return null;
  const sid = env.TOKENMAXXING_SESSION_ID;
  if (sid == null || sid === "") return null;
  return { sid, launchedAt: LaunchedAtSchema.parse(env.TOKENMAXXING_LAUNCHED_AT) ?? null, live: liveSessionId(sid) };
}

export function adoptLiveSession(session: SupervisedSession, stdinSid: string | undefined): SupervisedSession | null {
  if (stdinSid == null || stdinSid === session.live) return session;
  const child = presencePid({ dir: paths.presenceDir, id: session.sid });
  if (child == null || !spawnedThroughShellsBy(child)) {
    log("session.live_id_refused", { reason: child == null ? "no-presence" : "not-descendant", stdin: stdinSid.slice(0, 8), live: session.live.slice(0, 8), session: session.sid.slice(0, 8) });
    return null;
  }
  recordLiveSession(session.sid, stdinSid);
  log("session.live_id", { from: session.live.slice(0, 8), to: stdinSid.slice(0, 8), session: session.sid.slice(0, 8) });
  return { ...session, live: stdinSid };
}

export function writeRespawnMarker(input: { session: SupervisedSession; accountId: string; waitUntil: number; compact: boolean }): void {
  const payload: z.infer<typeof RespawnMarkerSchema> = {
    accountId: input.accountId,
    ts: Date.now(),
    waitUntil: input.waitUntil,
    sessionId: input.session.live,
    compact: input.compact,
    ...(input.session.launchedAt != null ? { launchedAt: input.session.launchedAt } : {}),
  };
  writeFileAtomic(join(paths.respawnDir, input.session.sid), JSON.stringify(payload));
}
