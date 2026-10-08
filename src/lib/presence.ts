import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { countBy } from "es-toolkit";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { pidExists, pidStartTimes } from "./proc.ts";
import { readJsonFile } from "./state.ts";
import { ErrnoSchema, JsonTextSchema } from "./types.ts";

export const PI_PRESENCE_PREFIX = "pi-";

const PresenceSchema = z.object({
  accountId: z.string(),
  pid: z.number(),
  startedAt: z.string(),
  apiKeyId: z.string().optional(),
});

export function writePresence(input: { dir: string; id: string; accountId: string; pid: number; apiKeyId?: string }): void {
  const startedAt = pidStartTimes([input.pid]).get(input.pid);
  if (startedAt == null) throw new Error(`could not read pid ${input.pid}'s start time (ps lstart) - refusing to write an unverifiable presence file`);
  writeFileAtomic(join(input.dir, input.id), JSON.stringify(PresenceSchema.parse({ accountId: input.accountId, pid: input.pid, startedAt, ...(input.apiKeyId != null ? { apiKeyId: input.apiKeyId } : {}) })));
}

export function presencePid(input: { dir: string; id: string }): number | null {
  try {
    return readJsonFile(join(input.dir, input.id), PresenceSchema).pid;
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return null;
    throw e;
  }
}

export function clearPresence(input: { dir: string; id: string }): void {
  rmSync(join(input.dir, input.id), { force: true });
}

export type LivingPresence = { id: string; accountId: string; apiKeyId?: string };

export function livingPresences(dir: string): LivingPresence[] {
  if (!existsSync(dir)) return [];
  const records: { name: string; file: string; record: z.infer<typeof PresenceSchema> }[] = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") continue;
      throw e;
    }
    const parsed = PresenceSchema.safeParse(JsonTextSchema.safeParse(raw).data);
    if (!parsed.success) {
      throw new Error(`${file} is not a readable presence record - it may belong to a RUNNING session, refusing to treat it as absent; remove the file (or respawn that session) to proceed`);
    }
    records.push({ name, file, record: parsed.data });
  }
  const started = pidStartTimes(records.map((r) => r.record.pid));
  const living: LivingPresence[] = [];
  for (const { name, file, record } of records) {
    const observed = started.get(record.pid);
    if (observed !== record.startedAt) {
      if (observed == null && pidExists(record.pid)) {
        throw new Error(`ps could not read the start time of live pid ${record.pid} (${file}) - refusing to clear a presence file that may guard a RUNNING session`);
      }
      rmSync(file, { force: true });
      continue;
    }
    living.push({ id: name, accountId: record.accountId, ...(record.apiKeyId != null ? { apiKeyId: record.apiKeyId } : {}) });
  }
  return living;
}

export function seatCounts(dir: string): Map<string, number> {
  return new Map(Object.entries(countBy(livingPresences(dir).filter((p) => p.apiKeyId == null), (p) => p.accountId)));
}
