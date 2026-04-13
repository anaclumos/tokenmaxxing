import { getDb } from "@/lib/db";
import { dueRuns } from "@/lib/db/schema";
import { eq, and, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export async function claimDueRuns(limit: number) {
  const db = getDb();
  const claimId = randomUUID();

  const result = await db.execute(sql`
    UPDATE due_runs
    SET status = 'claimed', claimed_at = NOW(), claimed_by = ${claimId}
    WHERE id IN (
      SELECT id FROM due_runs
      WHERE status = 'pending' AND due_at <= NOW()
      ORDER BY due_at ASC
      LIMIT ${limit}
    )
    RETURNING id, org_id, agent_id, run_type, routine_id
  `);

  return result.rows as {
    id: string;
    org_id: string;
    agent_id: string;
    run_type: string;
    routine_id: string | null;
  }[];
}

export async function reclaimStaleRuns(timeoutMinutes: number) {
  const db = getDb();
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  return db
    .update(dueRuns)
    .set({ status: "pending", claimedAt: null, claimedBy: null })
    .where(and(eq(dueRuns.status, "claimed"), lte(dueRuns.claimedAt, cutoff)))
    .returning({ id: dueRuns.id });
}

export async function enqueueDueRun(params: {
  orgId: string;
  agentId: string;
  dueAt: Date;
  runType: string;
  routineId?: string;
  idempotencyKey: string;
}) {
  const db = getDb();
  const [row] = await db.insert(dueRuns).values(params).returning();
  return row;
}

export async function markRunCompleted(runId: string) {
  const db = getDb();
  await db
    .update(dueRuns)
    .set({ status: "completed" })
    .where(eq(dueRuns.id, runId));
}

export async function markRunFailed(runId: string) {
  const db = getDb();
  await db
    .update(dueRuns)
    .set({ status: "failed" })
    .where(eq(dueRuns.id, runId));
}
