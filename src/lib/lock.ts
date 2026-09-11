import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { delay } from "es-toolkit";
import { lock } from "proper-lockfile";
import { z } from "zod";
import { log } from "./log.ts";

export const STALE_MS = 60_000;
export const UPDATE_MS = 5_000;
const STALL_MS = STALE_MS - UPDATE_MS;
const VERDICT_POLL_MS = 50;
const PAUSED_HOLDER_GRACE_MS = STALE_MS;
const ACQUIRE_ATTEMPTS = 600;
const ACQUIRE_MIN_DELAY_MS = 75;
const ACQUIRE_MAX_DELAY_MS = 500;

const ErrnoSchema = z.object({ code: z.string() });
const PidSchema = z.coerce.number().int().positive();

export type Lease = { path: string; release: () => Promise<void> };
export type PoolLock = { compromised: () => boolean };

export function assertHeld(lock: PoolLock, what: string): void {
  if (lock.compromised()) throw new Error(`the pool lock was reclaimed while held - refusing ${what}; the next evaluation retries`);
}

export type LeaseWatch = {
  onCompromised: (path: string) => (e: Error) => void;
  compromised: (path: string) => boolean;
  reset: () => void;
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
    reset: () => {
      lastTick = Date.now();
      stalledMs = 0;
    },
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
      for (let waited = 0; waited < 2 * UPDATE_MS; waited += VERDICT_POLL_MS) await delay(VERDICT_POLL_MS);
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

function isLocked(e: unknown): boolean {
  const errno = ErrnoSchema.safeParse(e);
  return errno.success && errno.data.code === "ELOCKED";
}

function holderPid(pidPath: string): number | null {
  try {
    return PidSchema.parse(readFileSync(pidPath, "utf8").trim());
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const errno = ErrnoSchema.safeParse(e);
    return errno.success && errno.data.code === "EPERM";
  }
}

async function waitForPausedHolder(lockDir: string, pidPath: string): Promise<void> {
  const started = Date.now();
  let logged = false;
  while (Date.now() - started < PAUSED_HOLDER_GRACE_MS) {
    let mtime: number;
    try {
      mtime = statSync(lockDir).mtimeMs;
    } catch {
      return;
    }
    if (Date.now() - mtime < STALE_MS) return;
    const pid = holderPid(pidPath);
    if (pid == null || pid === process.pid || !processAlive(pid)) return;
    if (!logged) log("lock.holder_paused", { lock: lockDir, pid });
    logged = true;
    await delay(VERDICT_POLL_MS * 10);
  }
  log("lock.holder_paused_reclaim", { lock: lockDir });
}

async function acquire(lockPath: string, onCompromised: (e: Error) => void): Promise<Lease> {
  const lockDir = `${lockPath}.lock`;
  const pidPath = `${lockDir}.pid`;
  for (let attempt = 1; ; attempt++) {
    await waitForPausedHolder(lockDir, pidPath);
    try {
      const release = await lock(lockPath, { realpath: false, stale: STALE_MS, update: UPDATE_MS, onCompromised });
      writeFileSync(pidPath, String(process.pid));
      return {
        path: lockDir,
        release: async () => {
          if (holderPid(pidPath) === process.pid) rmSync(pidPath, { force: true });
          await release();
        },
      };
    } catch (e) {
      if (!isLocked(e) || attempt >= ACQUIRE_ATTEMPTS) throw e;
    }
    await delay(ACQUIRE_MIN_DELAY_MS + Math.random() * (ACQUIRE_MAX_DELAY_MS - ACQUIRE_MIN_DELAY_MS));
  }
}

export async function withLock<T>(lockPath: string, fn: (lock: PoolLock) => Promise<T> | T): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const watch = watchLease(lockPath);
  let lease: Lease;
  try {
    lease = await acquire(lockPath, watch.onCompromised(`${lockPath}.lock`));
  } catch (e) {
    watch.stop();
    throw e;
  }
  watch.reset();
  try {
    const result = await fn({ compromised: () => watch.lost() != null });
    await watch.settle();
    const lost = watch.lost();
    if (lost != null) throw new Error(`the pool lock ${lockPath} was reclaimed while held (${lost}) - treat this critical section as failed`);
    return result;
  } finally {
    await releaseLease(lockPath, watch, [lease]);
  }
}
