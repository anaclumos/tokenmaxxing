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

export function writeCodexPresence(input: { supervisorId: string; accountId: string; pid?: number }): void {
  const pid = input.pid ?? process.pid;
  const startedAt = pidStartTime(pid);
  if (startedAt == null) throw new Error(`could not read pid ${pid}'s start time (ps lstart) - refusing to write an unverifiable presence file`);
  mkdirSync(codexPaths.presenceDir, { recursive: true });
  writeFileAtomic(
    join(codexPaths.presenceDir, input.supervisorId),
    JSON.stringify(PresenceSchema.parse({ accountId: input.accountId, pid, startedAt })),
  );
}

export function clearCodexPresence(input: { supervisorId: string }): void {
  rmSync(join(codexPaths.presenceDir, input.supervisorId), { force: true });
}

const LivingPresenceSchema = z.object({ supervisorId: z.string(), accountId: z.string() });
export type LivingPresence = z.infer<typeof LivingPresenceSchema>;

export function livingCodexPresences(): LivingPresence[] {
  const living: LivingPresence[] = [];
  if (!existsSync(codexPaths.presenceDir)) return living;
  for (const name of readdirSync(codexPaths.presenceDir)) {
    const file = join(codexPaths.presenceDir, name);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
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
      if (observed == null && pidExists(parsed.data.pid)) {
        throw new Error(`ps could not read the start time of live pid ${parsed.data.pid} (${file}) - refusing to clear a presence file that may guard a RUNNING codex session`);
      }
      rmSync(file, { force: true });
      continue;
    }
    living.push(LivingPresenceSchema.parse({ supervisorId: name, accountId: parsed.data.accountId }));
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
