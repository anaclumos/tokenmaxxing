// Which codex accounts are RUNNING right now. Codex cannot hot-swap, so a swap
// respawns only the session whose Stop hook decided it; sibling supervised
// sessions keep running on whatever account they started with, rotating that
// account's token live. Such an account is a landmine for the rest of the
// pool: its parked copy is superseded (refresh trips reuse punishment) and
// installing it as live would yank the running session's grant. Supervisors
// therefore declare their session's account in a presence file at every
// (re)spawn; the picker refuses to target present accounts and the sampler
// refuses to refresh their parked blobs. Staleness is checked by process
// IDENTITY (pid + ps lstart), not bare pid-aliveness: after a supervisor
// crash a recycled pid would otherwise keep its account benched forever.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codexPaths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { pidExists, pidStartTime } from "./proc.ts";

const PresenceSchema = z.object({
  accountId: z.string(),
  pid: z.number(),
  startedAt: z.string(),
});

export function writeCodexPresence(input: { supervisorId: string; accountId: string }): void {
  const startedAt = pidStartTime(process.pid);
  // Our own pid must exist; a null here means ps itself broke - corrupt state
  // to fail loudly on, never a masked placeholder.
  if (startedAt == null) throw new Error("could not read this process's own start time (ps lstart) - refusing to write an unverifiable presence file");
  mkdirSync(codexPaths.presenceDir, { recursive: true });
  writeFileAtomic(
    join(codexPaths.presenceDir, input.supervisorId),
    JSON.stringify(PresenceSchema.parse({ accountId: input.accountId, pid: process.pid, startedAt })),
  );
}

export function clearCodexPresence(input: { supervisorId: string }): void {
  rmSync(join(codexPaths.presenceDir, input.supervisorId), { force: true });
}

/** Account ids with a LIVING supervisor (pid + start-time identity match).
 *  Dead or recycled-pid presences are removed. A file that exists but fails to
 *  parse THROWS (review catch, PR #31): a presence file is what keeps a
 *  RUNNING session's account from being swapped out from under it, so damaged
 *  state must fail the decision loudly, never silently drop the protection. */
export function presentCodexAccountIds(): Set<string> {
  const present = new Set<string>();
  if (!existsSync(codexPaths.presenceDir)) return present;
  for (const name of readdirSync(codexPaths.presenceDir)) {
    const file = join(codexPaths.presenceDir, name);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      // a supervisor exiting between readdir and read clears its own file
      const errno = z.object({ code: z.string() }).safeParse(e);
      if (errno.success && errno.data.code === "ENOENT") continue;
      throw e;
    }
    const parsed = PresenceSchema.safeParse((() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })());
    if (!parsed.success) {
      throw new Error(`${file} is not a readable presence record - it may belong to a RUNNING codex session, refusing to treat it as absent; remove the file (or respawn that session) to proceed`);
    }
    const observed = pidStartTime(parsed.data.pid);
    if (observed !== parsed.data.startedAt) {
      // A null lstart is ambiguous: dead pid, or ps itself failing. Deleting
      // on a ps failure would silently unbench a RUNNING session's account
      // (review catch, PR #31), so only a confirmed-dead pid - or a live pid
      // with a DIFFERENT start time, a recycle - may clear the file.
      if (observed == null && pidExists(parsed.data.pid)) {
        throw new Error(`ps could not read the start time of live pid ${parsed.data.pid} (${file}) - refusing to clear a presence file that may guard a RUNNING codex session`);
      }
      rmSync(file, { force: true });
      continue;
    }
    present.add(parsed.data.accountId);
  }
  return present;
}

/** The accounts a swap may target: running accounts are off limits, except the
 *  seat itself (it is ranked as the incumbent, never installed over itself). */
export function targetableCodexAccounts<T extends { accountId: string }>(input: {
  accounts: T[];
  activeAccountId: string | null;
}): T[] {
  const present = presentCodexAccountIds();
  return input.accounts.filter(
    (account) => account.accountId === input.activeAccountId || !present.has(account.accountId),
  );
}
