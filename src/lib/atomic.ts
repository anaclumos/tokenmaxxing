// Atomic file writes (temp + rename on the same filesystem) and small fs utils.

import { closeSync, mkdirSync, openSync, renameSync, writeSync, fsyncSync } from "node:fs";
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
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
