import { existsSync } from "node:fs";
import { loadavg } from "node:os";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { withLock } from "./lock.ts";
import { log } from "./log.ts";
import { claudePool } from "./paths.ts";
import { pidExists } from "./proc.ts";
import { readJsonFile } from "./state.ts";

const BATCH_SIZE = 8;
const BATCH_GAP_MS = 15_000;
const POLL_MS = 1_000;

const GateSchema = z.object({
  batchAt: z.number(),
  waiting: z.record(z.string(), z.object({ pid: z.number().int(), requestedAt: z.number(), admitted: z.boolean() })),
});

export function admitResume(input: { sid: string; requestedAt: number; loadCap: number; now: number; load: number }): boolean {
  const gate = existsSync(claudePool.resumeGateJson) ? readJsonFile(claudePool.resumeGateJson, GateSchema) : { batchAt: 0, waiting: {} };
  const waiting = Object.fromEntries(Object.entries(gate.waiting).filter(([, w]) => pidExists(w.pid)));
  const own = (waiting[input.sid] ??= { pid: process.pid, requestedAt: input.requestedAt, admitted: false });
  let batchAt = gate.batchAt;
  if (!own.admitted && input.now - batchAt >= BATCH_GAP_MS && input.load < input.loadCap) {
    const queued = Object.entries(waiting).filter(([, w]) => !w.admitted).sort(([, a], [, b]) => a.requestedAt - b.requestedAt);
    const batch = queued.slice(0, BATCH_SIZE);
    for (const [, w] of batch) w.admitted = true;
    batchAt = input.now;
    log("supervisor.resume_batch", { load: input.load.toFixed(2), cap: input.loadCap, sessions: batch.map(([sid]) => sid.slice(0, 8)), waiting: queued.length - batch.length });
  }
  if (own.admitted) delete waiting[input.sid];
  writeFileAtomic(claudePool.resumeGateJson, JSON.stringify({ batchAt, waiting }));
  return own.admitted;
}

export async function awaitResumeTurn(sid: string, requestedAt: number, loadCap: number): Promise<void> {
  while (!(await withLock(claudePool.resumeLockFile, () => admitResume({ sid, requestedAt, loadCap, now: Date.now(), load: loadavg()[0] ?? 0 })))) {
    await Bun.sleep(POLL_MS);
  }
}
