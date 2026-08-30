import { mkdirSync, realpathSync, rmdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { delay } from "es-toolkit";
import { z } from "zod";
import { credDir } from "./paths.ts";
import { log } from "./log.ts";

const STALE_MS = 60_000;
const HEARTBEAT_MS = 5_000;
const ATTEMPTS = 5;
const RETRY_MS = 1_000;

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
  } catch {  }
  return false;
}

export async function withClaudeRefreshLock<T>(
  fn: (lock: { compromised: () => boolean }) => Promise<T> | T,
  opts: { attempts?: number; retryMs?: number; heartbeatMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? ATTEMPTS;
  const retryMs = opts.retryMs ?? RETRY_MS;
  const dir = credDir();
  mkdirSync(dir, { recursive: true });
  const primary = join(dir, ".oauth_refresh.lock");
  let legacyRoot = dir;
  try { legacyRoot = realpathSync(dir); } catch {  }
  const legacy = `${legacyRoot}.lock`;

  const held: string[] = [];
  for (let attempt = 1; held.length === 0; attempt++) {
    if (tryAcquire(primary)) {
      try {
        if (tryAcquire(legacy)) {
          held.push(legacy, primary);
          break;
        }
      } catch (e) {
        log("claudelock.legacy_error", { err: e instanceof Error ? e.message : String(e) });
        held.push(primary);
        break;
      }
      rmdirSync(primary);
    }
    if (attempt >= attempts) {
      log("claudelock.contested", { attempts: attempt });
      throw new Error(
        "claude's credential-refresh lock is contested (a token refresh is likely mid-flight) - not touching the live credential store; retry shortly",
      );
    }
    await delay(retryMs + Math.random() * retryMs);
  }

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
          markCompromised();
          continue;
        }
        utimesSync(d, now, now);
        ours.set(d, statSync(d).mtimeMs);
      } catch {
        markCompromised();
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
        if (statSync(d).mtimeMs === ours.get(d)) rmdirSync(d);
      } catch {  }
    }
  }
}
