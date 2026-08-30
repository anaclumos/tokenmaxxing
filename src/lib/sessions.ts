import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";

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
