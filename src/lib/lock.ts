import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";
import { log } from "./log.ts";

const STALE_MS = 60_000;
const UPDATE_MS = 5_000;
const RETRIES = { retries: 600, minTimeout: 75, maxTimeout: 500, randomize: true } as const;

export async function withLock<T>(lockPath: string, fn: () => Promise<T> | T): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const lease: { compromised: Error | null } = { compromised: null };
  const release = await lock(lockPath, {
    realpath: false,
    stale: STALE_MS,
    update: UPDATE_MS,
    retries: RETRIES,
    onCompromised: (e) => {
      if (lease.compromised == null) log("lock.compromised", { path: lockPath, err: e.message });
      lease.compromised ??= e;
    },
  });
  try {
    const result = await fn();
    if (lease.compromised) {
      throw new Error(`the pool lock ${lockPath} was reclaimed while held (${lease.compromised.message}) - treat this critical section as failed`);
    }
    return result;
  } finally {
    await release().catch((e: unknown) => log("lock.release_failed", { path: lockPath, err: e instanceof Error ? e.message : String(e) }));
  }
}
