import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}`;
  try {
    const fd = openSync(tmp, "wx", mode);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
