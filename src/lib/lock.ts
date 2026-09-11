import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { delay } from "es-toolkit";
import { lock } from "proper-lockfile";
import { log } from "./log.ts";

export const STALE_MS = 60_000;
export const UPDATE_MS = 5_000;
const STALL_MS = STALE_MS - UPDATE_MS;
const VERDICT_POLL_MS = 50;
const RETRIES = { retries: 600, minTimeout: 75, maxTimeout: 500, randomize: true } as const;

export type Lease = { path: string; release: () => Promise<void> };
export type PoolLock = { compromised: () => boolean };

export function assertHeld(lock: PoolLock, what: string): void {
  if (lock.compromised()) throw new Error(`the pool lock was reclaimed while held - refusing ${what}; the next evaluation retries`);
}

export type LeaseWatch = {
  onCompromised: (path: string) => (e: Error) => void;
  compromised: (path: string) => boolean;
  lost: () => string | null;
  settle: () => Promise<void>;
  stop: () => void;
};

export function watchLease(name: string): LeaseWatch {
  const compromised = new Map<string, Error>();
  let stalledMs = 0;
  let verified = false;
  let settled = false;
  let lastTick = Date.now();
  const noteStall = () => {
    const gap = Date.now() - lastTick;
    if (gap > STALL_MS) stalledMs = Math.max(stalledMs, gap);
  };
  const ticker = setInterval(() => {
    noteStall();
    lastTick = Date.now();
  }, UPDATE_MS);
  ticker.unref();
  return {
    onCompromised: (path) => (e) => {
      if (!compromised.has(path)) log("lock.compromised", { lock: name, path, err: e.message });
      compromised.set(path, e);
    },
    compromised: (path) => compromised.has(path),
    lost: () => {
      noteStall();
      const first = compromised.values().next().value;
      if (first) return first.message;
      if (stalledMs > 0 && !verified) {
        return `this process stalled ${Math.round(stalledMs / 1000)}s, past the ${STALE_MS / 1000}s stale bar, so another holder may own the lock`;
      }
      return null;
    },
    settle: async () => {
      if (settled) return;
      settled = true;
      noteStall();
      if (stalledMs === 0) return;
      log("lock.stalled", { lock: name, stalledMs });
      for (let waited = 0; compromised.size === 0 && waited < 2 * UPDATE_MS; waited += VERDICT_POLL_MS) await delay(VERDICT_POLL_MS);
      if (compromised.size === 0) verified = true;
    },
    stop: () => clearInterval(ticker),
  };
}

export async function releaseLease(name: string, watch: LeaseWatch, leases: Lease[]): Promise<void> {
  watch.stop();
  await watch.settle();
  for (const lease of leases) {
    if (watch.compromised(lease.path)) {
      log("lock.release_skipped", { lock: name, path: lease.path });
      continue;
    }
    await lease.release().catch((e: unknown) => log("lock.release_failed", { lock: name, path: lease.path, err: e instanceof Error ? e.message : String(e) }));
  }
}

export async function withLock<T>(lockPath: string, fn: (lock: PoolLock) => Promise<T> | T): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const watch = watchLease(lockPath);
  let release: () => Promise<void>;
  try {
    release = await lock(lockPath, {
      realpath: false,
      stale: STALE_MS,
      update: UPDATE_MS,
      retries: RETRIES,
      onCompromised: watch.onCompromised(lockPath),
    });
  } catch (e) {
    watch.stop();
    throw e;
  }
  try {
    const result = await fn({ compromised: () => watch.lost() != null });
    await watch.settle();
    const lost = watch.lost();
    if (lost != null) throw new Error(`the pool lock ${lockPath} was reclaimed while held (${lost}) - treat this critical section as failed`);
    return result;
  } finally {
    await releaseLease(lockPath, watch, [{ path: lockPath, release }]);
  }
}
