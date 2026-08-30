import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";

export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}`;
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  const fd = openSync(tmp, "wx", mode);
  try {
    try {
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
    try {
      rmSync(tmp, { force: true });
    } catch {
    }
    throw e;
  }
}
