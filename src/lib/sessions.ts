// Persist the flags a managed session was launched with, so any later relaunch
// of that session id (a fresh supervisor invocation, or the depleted-pool
// recovery in #20) re-applies them instead of dropping --dangerously-skip-
// permissions / --model / etc.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";

const SessionSchema = z.object({ flags: z.array(z.string()), cwd: z.string() });

// Matches claude's default transcript retention (cleanupPeriodDays 30): a
// transcript claude has already deleted cannot be resumed, so its flags file
// is dead weight. saveSessionFlags rewrites the file on every (re)launch, so
// an actively resumed session keeps its mtime fresh and is never pruned.
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

/** Delete session files past the retention window (also reaps stale
 *  writeFileAtomic temp siblings from a crashed writer). */
export function pruneStaleSessions(now: number): void {
  const dir = join(paths.home, "sessions");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      if (now - statSync(p).mtimeMs > SESSION_RETENTION_MS) rmSync(p, { force: true });
    } catch {
      // A concurrent writeFileAtomic renames its tmp sibling away between
      // readdir and stat; a vanished entry needs no pruning.
    }
  }
}
