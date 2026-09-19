import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { RespawnMarkerSchema } from "./types.ts";

const SessionSchema = z.object({ flags: z.array(z.string()), cwd: z.string() });

const SESSION_RETENTION_MS = 30 * 24 * 3600 * 1000;

function sessionFile(sid: string): string {
  return join(paths.home, "sessions", `${sid}.json`);
}

export function saveSessionFlags(sid: string, flags: string[], cwd: string): void {
  mkdirSync(join(paths.home, "sessions"), { recursive: true });
  writeFileAtomic(sessionFile(sid), JSON.stringify({ flags, cwd }));
}

export function loadSessionFlags(sid: string): string[] | null {
  const f = sessionFile(sid);
  if (!existsSync(f)) return null;
  return SessionSchema.parse(JSON.parse(readFileSync(f, "utf8"))).flags;
}

export function pruneStaleSessions(now: number): void {
  const dir = join(paths.home, "sessions");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
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
