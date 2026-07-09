// Cross-process advisory locking via flock(2) through bun:ffi on a real file
// descriptor (macOS ships no flock(1) binary, and one codepath serves both
// platforms). The lock is released when we close the fd (explicitly or on
// process exit).

import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { dlopen, FFIType, suffix } from "bun:ffi";

// sys/file.h (identical on darwin + linux): LOCK_SH=1 LOCK_EX=2 LOCK_NB=4 LOCK_UN=8
const LOCK_EX = 2;
const LOCK_UN = 8;

let _flock: ((fd: number, op: number) => number) | null = null;

function flockFn(): (fd: number, op: number) => number {
  if (_flock) return _flock;
  // darwin: flock(2) is in libSystem; the bare name resolves via the dyld shared
  // cache even though no physical .dylib exists on disk (verified 2026-07-08).
  // linux: glibc's libc.so.6 (verified in-container 2026-07-09, arm64).
  const candidates =
    process.platform === "darwin"
      ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib", `libc.${suffix}`]
      : [`libc.so.6`, `libc.${suffix}`];
  let lib: ReturnType<typeof dlopen> | null = null;
  let lastErr: unknown;
  for (const path of candidates) {
    try {
      lib = dlopen(path, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!lib) throw new Error(`could not load flock(2): ${String(lastErr)}`);
  const sym = lib.symbols.flock as unknown as (fd: number, op: number) => number;
  _flock = sym;
  return _flock;
}

/**
 * Acquire an exclusive advisory lock on `lockPath`, blocking until available.
 * Returns a handle whose release() drops the lock. The lock is process-scoped
 * (held via an open fd) so racing hooks in separate processes serialize.
 */
export function acquireLock(lockPath: string): { release: () => void } {
  mkdirSync(dirname(lockPath), { recursive: true });
  const fd = openSync(lockPath, "a", 0o600);
  const flock = flockFn();
  const rc = flock(fd, LOCK_EX);
  if (rc !== 0) {
    closeSync(fd);
    throw new Error(`flock LOCK_EX failed on ${lockPath} (rc=${rc})`);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      flock(fd, LOCK_UN);
    } finally {
      closeSync(fd);
    }
  };
  return { release };
}

/** Run `fn` while holding `lockPath`; always releases, even on throw. */
export async function withLock<T>(lockPath: string, fn: () => Promise<T> | T): Promise<T> {
  const held = acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    held.release();
  }
}
