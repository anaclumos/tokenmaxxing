// Atomic file writes (temp + rename on the same filesystem) and small fs utils.

import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write `data` to `file` atomically: write a sibling temp file, fsync it, then
 * rename over the target. A concurrent reader sees either the old or new file,
 * never a partial one.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}`;
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  const fd = openSync(tmp, "wx", mode);
  try {
    try {
      // write(2) may write FEWER bytes than asked without throwing (ENOSPC mid-
      // write, signal interruption): loop until done and fail loudly on a stuck
      // fd, or a truncated temp file gets fsynced and renamed over the target
      // as a successful-looking corrupt file (closing-review catch - for a
      // parked credential that silently loses a just-rotated refresh token).
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset);
        if (written <= 0) throw new Error(`short write on ${tmp}: ${offset}/${bytes.length} bytes (disk full?)`);
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    // a failed write must not strand the partial temp file - it can hold a
    // truncated credential (PR #36 review catch)
    rmSync(tmp, { force: true });
    throw e;
  }
}
