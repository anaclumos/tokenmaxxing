// Linked-worktree detection for the statusLine. A linked worktree's root holds
// a .git FILE (a gitdir pointer) where the main checkout has a .git directory.
// Read the filesystem directly - never a git subprocess.

import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The worktree root's basename when `dir` is inside a LINKED git worktree;
 *  null in a main checkout or outside any repository. Any fs error while
 *  walking (EACCES, ENOTDIR, stale mounts) is also null: the status line must
 *  never break over an unreadable path. */
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
