// Interlock with Claude Code's OWN credential-refresh locks so our live-store
// writes can't interleave with a concurrent token refresh. Binary-verified
// against 2.1.214's embedded refresh code: claude takes TWO proper-lockfile
// (mkdir-based) locks rooted at its credentials dir - the primary
// <credDir>/.oauth_refresh.lock plus a legacy sibling <realpath(credDir)>.lock
// (~/.claude.lock by default, kept for coordination with older versions) -
// with stale: 60s, a 5s lock-mtime heartbeat while held, and on contention it
// retries 5x with 1-2s jitter then FAILS the refresh (lock_timeout) instead of
// proceeding unlocked. We mirror all of that, including the failure: a lock
// still held past the retries means a refresh is mid-flight, which is exactly
// when a live-store write could clobber a rotation. Callers retry next tick.
//
// Theft is detected the way proper-lockfile does it: the heartbeat re-stats
// each lock and compares against the mtime WE last stored - a deviation or a
// vanished dir means someone reclaimed the lock (only possible if this process
// stalled past the 60s stale bar). fn gets a `compromised()` probe to check
// before persisting, release skips dirs we no longer own, and the wrapper
// throws terminally so no caller trusts work done on a stolen lock.

import { mkdirSync, realpathSync, rmdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { delay } from "es-toolkit";
import { z } from "zod";
import { credDir } from "./paths.ts";
import { log } from "./log.ts";

const STALE_MS = 60_000; // claude's own proper-lockfile `stale`
const HEARTBEAT_MS = 5_000; // claude's own `update` cadence
const ATTEMPTS = 5; // claude's own ELOCKED retry budget
const RETRY_MS = 1_000; // claude sleeps 1000 + rand(1000) between attempts

/** mkdir-take one lock dir, reclaiming it when older than claude's stale bar. */
function tryAcquire(lockDir: string): boolean {
  try {
    mkdirSync(lockDir);
    return true;
  } catch (e) {
    const errno = z.object({ code: z.string() }).safeParse(e);
    if (!errno.success || errno.data.code !== "EEXIST") throw e;
  }
  try {
    if (Date.now() - statSync(lockDir).mtimeMs > STALE_MS) {
      rmdirSync(lockDir);
      mkdirSync(lockDir);
      return true;
    }
  } catch { /* raced: another actor reclaimed it first */ }
  return false;
}

export async function withClaudeRefreshLock<T>(
  fn: (lock: { compromised: () => boolean }) => Promise<T> | T,
  opts: { attempts?: number; retryMs?: number; heartbeatMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? ATTEMPTS;
  const retryMs = opts.retryMs ?? RETRY_MS;
  const dir = credDir();
  mkdirSync(dir, { recursive: true }); // claude mkdirs it before locking too
  const primary = join(dir, ".oauth_refresh.lock");
  let legacyRoot = dir;
  try { legacyRoot = realpathSync(dir); } catch { /* unresolvable: lock the raw path, like claude */ }
  const legacy = `${legacyRoot}.lock`;

  const held: string[] = []; // in release order: legacy first, then primary (claude's order)
  for (let attempt = 1; held.length === 0; attempt++) {
    if (tryAcquire(primary)) {
      try {
        if (tryAcquire(legacy)) {
          held.push(legacy, primary);
          break;
        }
      } catch (e) {
        // claude proceeds on a legacy acquire ERROR; only contention aborts.
        log("claudelock.legacy_error", { err: e instanceof Error ? e.message : String(e) });
        held.push(primary);
        break;
      }
      rmdirSync(primary); // legacy contested: release and re-take both, like claude
    }
    if (attempt >= attempts) {
      log("claudelock.contested", { attempts: attempt });
      throw new Error(
        "claude's credential-refresh lock is contested (a token refresh is likely mid-flight) - not touching the live credential store; retry shortly",
      );
    }
    await delay(retryMs + Math.random() * retryMs);
  }

  // the mtime we last stored per lock; a deviation means the lock was stolen.
  const ours = new Map<string, number>();
  for (const d of held) ours.set(d, statSync(d).mtimeMs);
  let compromised = false;
  const markCompromised = () => {
    if (!compromised) {
      compromised = true;
      log("claudelock.compromised", {});
    }
  };
  const heartbeat = setInterval(() => {
    const now = new Date();
    for (const d of held) {
      try {
        if (statSync(d).mtimeMs !== ours.get(d)) {
          markCompromised(); // someone re-took it; stop touching their lock
          continue;
        }
        utimesSync(d, now, now);
        ours.set(d, statSync(d).mtimeMs);
      } catch {
        markCompromised(); // dir vanished: stolen or force-cleaned
      }
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);

  try {
    const result = await fn({ compromised: () => compromised });
    if (compromised) {
      throw new Error("claude's credential-refresh lock was reclaimed while held (this process stalled past the 60s stale bar) - treat this critical section as failed");
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    for (const d of held) {
      try {
        if (statSync(d).mtimeMs === ours.get(d)) rmdirSync(d); // release only what is still ours
      } catch { /* already gone */ }
    }
  }
}
