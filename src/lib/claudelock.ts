import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { delay } from "es-toolkit";
import { lock } from "proper-lockfile";
import { z } from "zod";
import { credDir } from "./paths.ts";
import { log } from "./log.ts";

const STALE_MS = 60_000;
const UPDATE_MS = 5_000;
const ATTEMPTS = 5;
const RETRY_MS = 1_000;

const ErrnoSchema = z.object({ code: z.string() });

function isLocked(e: unknown): boolean {
  const errno = ErrnoSchema.safeParse(e);
  return errno.success && errno.data.code === "ELOCKED";
}

export async function withClaudeRefreshLock<T>(
  fn: (lock: { compromised: () => boolean }) => Promise<T> | T,
  opts: { attempts?: number; retryMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? ATTEMPTS;
  const retryMs = opts.retryMs ?? RETRY_MS;
  const dir = credDir();
  mkdirSync(dir, { recursive: true });
  const primary = join(dir, ".oauth_refresh.lock");
  let legacyRoot = dir;
  try { legacyRoot = realpathSync(dir); } catch {  }
  const legacy = `${legacyRoot}.lock`;

  let compromised = false;
  const options = (lockfilePath: string) => ({
    lockfilePath,
    realpath: false,
    stale: STALE_MS,
    update: UPDATE_MS,
    onCompromised: (e: Error) => {
      if (!compromised) log("claudelock.compromised", { err: e.message });
      compromised = true;
    },
  });

  const releases: Array<() => Promise<void>> = [];
  for (let attempt = 1; releases.length === 0; attempt++) {
    let releasePrimary: (() => Promise<void>) | null = null;
    try {
      releasePrimary = await lock(dir, options(primary));
      try {
        releases.push(await lock(legacy, options(legacy)), releasePrimary);
        break;
      } catch (e) {
        if (!isLocked(e)) {
          log("claudelock.legacy_error", { err: e instanceof Error ? e.message : String(e) });
          releases.push(releasePrimary);
          break;
        }
        await releasePrimary();
      }
    } catch (e) {
      if (!isLocked(e)) throw e;
    }
    if (attempt >= attempts) {
      log("claudelock.contested", { attempts: attempt });
      throw new Error(
        "claude's credential-refresh lock is contested (a token refresh is likely mid-flight) - not touching the live credential store; retry shortly",
      );
    }
    await delay(retryMs + Math.random() * retryMs);
  }

  try {
    const result = await fn({ compromised: () => compromised });
    if (compromised) {
      throw new Error("claude's credential-refresh lock was reclaimed while held (this process stalled past the 60s stale bar) - treat this critical section as failed");
    }
    return result;
  } finally {
    for (const release of releases) {
      await release().catch((e: unknown) => log("claudelock.release_failed", { err: e instanceof Error ? e.message : String(e) }));
    }
  }
}
