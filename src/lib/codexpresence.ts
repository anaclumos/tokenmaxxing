import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codexPaths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { errnoCode } from "./errors.ts";
import { tryParseJson } from "./json.ts";
import { pidExists, pidStartTime } from "./proc.ts";

const PresenceSchema = z.object({
  accountId: z.string(),
  pid: z.number(),
  startedAt: z.string(),
});
type Presence = z.infer<typeof PresenceSchema>;

export function writeCodexPresence(input: { supervisorId: string; accountId: string; pid?: number }): void {
  const pid = input.pid ?? process.pid;
  const startedAt = pidStartTime(pid);
  if (startedAt == null) throw new Error(`could not read pid ${pid}'s start time (ps lstart) - refusing to write an unverifiable presence file`);
  mkdirSync(codexPaths.presenceDir, { recursive: true });
  const presence: Presence = { accountId: input.accountId, pid, startedAt };
  writeFileAtomic(join(codexPaths.presenceDir, input.supervisorId), JSON.stringify(presence));
}

export function clearCodexPresence(input: { supervisorId: string }): void {
  rmSync(join(codexPaths.presenceDir, input.supervisorId), { force: true });
}

export type LivingPresence = { supervisorId: string; accountId: string };

export function livingCodexPresences(): LivingPresence[] {
  const living: LivingPresence[] = [];
  if (!existsSync(codexPaths.presenceDir)) return living;
  for (const name of readdirSync(codexPaths.presenceDir)) {
    const file = join(codexPaths.presenceDir, name);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      if (errnoCode(e) === "ENOENT") continue;
      throw e;
    }
    const presence = tryParseJson(PresenceSchema, raw);
    if (!presence) {
      throw new Error(`${file} is not a readable presence record - it may belong to a RUNNING codex session, refusing to treat it as absent; remove the file (or respawn that session) to proceed`);
    }
    const observed = pidStartTime(presence.pid);
    if (observed !== presence.startedAt) {
      if (observed == null && pidExists(presence.pid)) {
        throw new Error(`ps could not read the start time of live pid ${presence.pid} (${file}) - refusing to clear a presence file that may guard a RUNNING codex session`);
      }
      rmSync(file, { force: true });
      continue;
    }
    living.push({ supervisorId: name, accountId: presence.accountId });
  }
  return living;
}

export function presentCodexAccountIds(): Set<string> {
  return new Set(livingCodexPresences().map((presence) => presence.accountId));
}

export function targetableCodexAccounts<T extends { accountId: string }>(input: {
  accounts: T[];
  activeAccountId: string | null;
}): T[] {
  const present = presentCodexAccountIds();
  return input.accounts.filter(
    (account) => account.accountId === input.activeAccountId || !present.has(account.accountId),
  );
}
