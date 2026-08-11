// Cross-process advisory locking via flock(2) through bun:ffi on a real file
// descriptor (macOS ships no flock(1) binary, and one codepath serves both
// platforms). The lock is released when we close the fd (explicitly or on
// process exit).
//
// The acquire is NON-BLOCKING (LOCK_EX|LOCK_NB) with an async retry loop: a
// blocking LOCK_EX from this runtime freezes the whole event loop.
// EWOULDBLOCK is told apart from real failures via errno, so a bad fd still
// fails fast instead of spinning.

import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { dlopen, FFIType, read } from "bun:ffi";
import { delay } from "es-toolkit";

// sys/file.h (identical on darwin + linux): LOCK_SH=1 LOCK_EX=2 LOCK_NB=4 LOCK_UN=8
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
// errno.h: EWOULDBLOCK/EAGAIN is 35 on darwin, 11 on linux; EINTR is 4 on both.
const EAGAIN = process.platform === "darwin" ? 35 : 11;
const EINTR = 4;
const RETRY_MS = 75;

const FLOCK_DEF = { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } } as const;

// darwin: flock(2) + __error live in libSystem; the bare name resolves via the
// dyld shared cache even though no physical .dylib exists on disk (verified
// 2026-07-08). linux: glibc's libc.so.6 + __errno_location (verified
// in-container 2026-07-09, arm64). Exactly one verified path per platform -
// a broken environment fails fast instead of falling through a guess list.
function loadLibc() {
  if (process.platform === "darwin") {
    const lib = dlopen("libSystem.B.dylib", { ...FLOCK_DEF, __error: { args: [], returns: FFIType.ptr } });
    return { flock: lib.symbols.flock, errnoPtr: lib.symbols.__error };
  }
  const lib = dlopen("libc.so.6", { ...FLOCK_DEF, __errno_location: { args: [], returns: FFIType.ptr } });
  return { flock: lib.symbols.flock, errnoPtr: lib.symbols.__errno_location };
}

let _libc: ReturnType<typeof loadLibc> | null = null;

function libc(): ReturnType<typeof loadLibc> {
  _libc ??= loadLibc();
  return _libc;
}

function currentErrno(): number {
  const p = libc().errnoPtr();
  return p == null ? -1 : read.i32(p, 0);
}

/**
 * Acquire an exclusive advisory lock on `lockPath`, waiting (without blocking
 * the event loop) until available. Returns a handle whose release() drops the
 * lock. The lock is fd-scoped, so racing hooks in separate processes serialize
 * and same-process actors queue on the retry loop.
 */
export async function acquireLock(lockPath: string): Promise<{ release: () => void }> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const fd = openSync(lockPath, "a", 0o600);
  const { flock } = libc();
  try {
    while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      const errno = currentErrno();
      if (errno !== EAGAIN && errno !== EINTR) {
        throw new Error(`flock LOCK_EX|LOCK_NB failed on ${lockPath} (errno ${errno})`);
      }
      await delay(RETRY_MS);
    }
  } catch (e) {
    closeSync(fd);
    throw e;
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
  const held = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    held.release();
  }
}
