import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";

export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}`;
  const fd = openSync(tmp, "wx", mode);
  try {
    try {
      writeFileSync(fd, data);
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
