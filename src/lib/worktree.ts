import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function worktreeName(dir: string): string | null {
  try {
    for (let cur = dir; ; cur = dirname(cur)) {
      const st = statSync(join(cur, ".git"), { throwIfNoEntry: false });
      if (st) return st.isFile() ? basename(cur) : null;
      if (dirname(cur) === cur) return null;
    }
  } catch {
    return null;
  }
}
