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

export type LeaseWatch = {
  onCompromised: (e: Error) => void;
  lost: () => string | null;
  settle: () => Promise<void>;
  stop: () => void;
};

export function watchLease(name: string): LeaseWatch {
  let compromised: Error | null = null;
  let stalledMs = 0;
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
    onCompromised: (e) => {
      if (compromised == null) log("lock.compromised", { lock: name, err: e.message });
      compromised ??= e;
    },
    lost: () => compromised?.message ?? null,
    settle: async () => {
      if (settled) return;
      settled = true;
      noteStall();
      if (stalledMs === 0) return;
      log("lock.stalled", { lock: name, stalledMs });
      for (let waited = 0; compromised == null && waited < 2 * UPDATE_MS; waited += VERDICT_POLL_MS) await delay(VERDICT_POLL_MS);
    },
    stop: () => clearInterval(ticker),
  };
}

export async function releaseLease(name: string, watch: LeaseWatch, releases: Array<() => Promise<void>>): Promise<void> {
  watch.stop();
  await watch.settle();
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
    await watch.settle();
    const lost = watch.lost();
    if (lost != null) throw new Error(`the pool lock ${lockPath} was reclaimed while held (${lost}) - treat this critical section as failed`);
    return result;
  } finally {
    await releaseLease(lockPath, watch, [release]);
  }
}
