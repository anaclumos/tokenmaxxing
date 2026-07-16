// Which codex accounts are RUNNING right now. Codex cannot hot-swap, so a swap
// respawns only the session whose Stop hook decided it; sibling supervised
// sessions keep running on whatever account they started with, rotating that
// account's token live. Such an account is a landmine for the rest of the
// pool: its parked copy is superseded (refresh trips reuse punishment) and
// installing it as live would yank the running session's grant. Supervisors
// therefore declare their session's account in a presence file at every
// (re)spawn; the picker refuses to target present accounts and the sampler
// refuses to refresh their parked blobs. Staleness is PID-based: a presence
// whose supervisor died is ignored and cleaned up.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codexPaths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";

const PresenceSchema = z.object({
  accountId: z.string(),
  pid: z.number(),
  ts: z.number(),
});

export function writeCodexPresence(input: { supervisorId: string; accountId: string }): void {
  mkdirSync(codexPaths.presenceDir, { recursive: true });
  writeFileAtomic(
    join(codexPaths.presenceDir, input.supervisorId),
    JSON.stringify(PresenceSchema.parse({ accountId: input.accountId, pid: process.pid, ts: Date.now() })),
  );
}

export function clearCodexPresence(input: { supervisorId: string }): void {
  rmSync(join(codexPaths.presenceDir, input.supervisorId), { force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Account ids with a LIVING supervisor. Dead supervisors' files are removed. */
export function presentCodexAccountIds(): Set<string> {
  const present = new Set<string>();
  if (!existsSync(codexPaths.presenceDir)) return present;
  for (const name of readdirSync(codexPaths.presenceDir)) {
    const file = join(codexPaths.presenceDir, name);
    const parsed = PresenceSchema.safeParse((() => {
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    })());
    if (!parsed.success || !pidAlive(parsed.data.pid)) {
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
