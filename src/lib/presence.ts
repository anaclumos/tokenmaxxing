import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { pidExists, pidStartTime } from "./proc.ts";
import { ErrnoSchema } from "./types.ts";

const PresenceSchema = z.object({
  accountId: z.string(),
  pid: z.number(),
  startedAt: z.string(),
});

export function writePresence(input: { dir: string; id: string; accountId: string; pid: number }): void {
  const startedAt = pidStartTime(input.pid);
  if (startedAt == null) throw new Error(`could not read pid ${input.pid}'s start time (ps lstart) - refusing to write an unverifiable presence file`);
  mkdirSync(input.dir, { recursive: true });
  writeFileAtomic(join(input.dir, input.id), JSON.stringify(PresenceSchema.parse({ accountId: input.accountId, pid: input.pid, startedAt })));
}

export function presencePid(input: { dir: string; id: string }): number | null {
  const file = join(input.dir, input.id);
  if (!existsSync(file)) return null;
  return PresenceSchema.parse(JSON.parse(readFileSync(file, "utf8"))).pid;
}

export function clearPresence(input: { dir: string; id: string }): void {
  rmSync(join(input.dir, input.id), { force: true });
}

export type LivingPresence = { id: string; accountId: string };

export function livingPresences(dir: string): LivingPresence[] {
  const living: LivingPresence[] = [];
  if (!existsSync(dir)) return living;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") continue;
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
      throw new Error(`${file} is not a readable presence record - it may belong to a RUNNING session, refusing to treat it as absent; remove the file (or respawn that session) to proceed`);
    }
    const observed = pidStartTime(parsed.data.pid);
    if (observed !== parsed.data.startedAt) {
      if (observed == null && pidExists(parsed.data.pid)) {
        throw new Error(`ps could not read the start time of live pid ${parsed.data.pid} (${file}) - refusing to clear a presence file that may guard a RUNNING session`);
      }
      rmSync(file, { force: true });
      continue;
    }
    living.push({ id: name, accountId: parsed.data.accountId });
  }
  return living;
}

export function seatCounts(dir: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const presence of livingPresences(dir)) counts.set(presence.accountId, (counts.get(presence.accountId) ?? 0) + 1);
  return counts;
}
