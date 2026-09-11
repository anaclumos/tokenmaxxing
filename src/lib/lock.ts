import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";
import { log } from "./log.ts";

export const STALE_MS = 60_000;
export const UPDATE_MS = 5_000;
const STALL_MS = STALE_MS - UPDATE_MS;
const RETRIES = { retries: 600, minTimeout: 75, maxTimeout: 500, randomize: true } as const;

export type LeaseWatch = {
  onCompromised: (e: Error) => void;
  lost: () => string | null;
  stop: () => void;
};

export function watchLease(name: string): LeaseWatch {
  let compromised: Error | null = null;
  let lastTick = Date.now();
  const ticker = setInterval(() => {
    lastTick = Date.now();
  }, UPDATE_MS);
  ticker.unref();
  return {
    onCompromised: (e) => {
      if (compromised == null) log("lock.compromised", { lock: name, err: e.message });
      compromised ??= e;
    },
    lost: () => {
      if (compromised) return compromised.message;
      const stall = Date.now() - lastTick;
      return stall > STALL_MS ? `this process stalled ${Math.round(stall / 1000)}s, past the ${STALE_MS / 1000}s stale bar, so another holder may own the lock` : null;
    },
    stop: () => clearInterval(ticker),
  };
}

export async function releaseLease(name: string, watch: LeaseWatch, releases: Array<() => Promise<void>>): Promise<void> {
  watch.stop();
  const lost = watch.lost();
  if (lost != null) {
    log("lock.release_skipped", { lock: name, why: lost });
    return;
  }
  for (const release of releases) {
    await release().catch((e: unknown) => log("lock.release_failed", { lock: name, err: e instanceof Error ? e.message : String(e) }));
  }
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T> | T): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const watch = watchLease(lockPath);
  let release: () => Promise<void>;
  try {
    release = await lock(lockPath, {
      realpath: false,
      stale: STALE_MS,
      update: UPDATE_MS,
      retries: RETRIES,
      onCompromised: watch.onCompromised,
    });
  } catch (e) {
    watch.stop();
    throw e;
  }
  try {
    const result = await fn();
    const lost = watch.lost();
    if (lost != null) throw new Error(`the pool lock ${lockPath} was reclaimed while held (${lost}) - treat this critical section as failed`);
    return result;
  } finally {
    await releaseLease(lockPath, watch, [release]);
  }
}
