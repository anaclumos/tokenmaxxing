import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { dlopen, FFIType, read } from "bun:ffi";
import { delay } from "es-toolkit";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EAGAIN = process.platform === "darwin" ? 35 : 11;
const EINTR = 4;
const RETRY_MS = 75;

const FLOCK_DEF = { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } } as const;

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

export async function withLock<T>(lockPath: string, fn: () => Promise<T> | T): Promise<T> {
  const held = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    held.release();
  }
}
