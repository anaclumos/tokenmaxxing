import { usageRecords } from "@tokenmaxxing/db/index";
import { SubmitPayload } from "@tokenmaxxing/shared/types";
import { getUnlockedBadges } from "@tokenmaxxing/shared/unlocked-badges";
import { after } from "next/server";
import { dailyAggregates } from "@tokenmaxxing/db/index";
import { eq } from "drizzle-orm";

import { recomputeAggregates } from "@/lib/aggregates";
import { authenticateToken } from "@/lib/auth";
import { db } from "@/lib/db";

export async function POST(req: Request) {
  const userId = await authenticateToken(req);
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = SubmitPayload.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid payload", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const values = parsed.data.records.map((r) => ({
    userId,
    client: r.client,
    model: r.model,
    sessionHash: r.sessionHash,
    timestamp: new Date(r.timestamp),
    inputTokens: r.tokens.input,
    outputTokens: r.tokens.output,
    cacheReadTokens: r.tokens.cacheRead,
    cacheWriteTokens: r.tokens.cacheWrite,
    reasoningTokens: r.tokens.reasoning,
    costUsd: r.costUsd.toFixed(6),
    project: r.project ?? null,
  }));

  // Single INSERT ... ON CONFLICT DO NOTHING RETURNING id
  // Duplicates (by sessionHash) are silently skipped; RETURNING gives us only inserted rows
  const result = await db()
    .insert(usageRecords)
    .values(values)
    .onConflictDoNothing({ target: usageRecords.sessionHash })
    .returning({ id: usageRecords.id, sessionHash: usageRecords.sessionHash });

  const inserted = result.length;
  const insertedSessionHashes = new Set(result.map((row) => row.sessionHash));
  const insertedValues = values.filter((value) => insertedSessionHashes.has(value.sessionHash));
  const unlockedBadges =
    insertedValues.length > 0
      ? getUnlockedBadges({
          rows: await db()
            .select({
              date: dailyAggregates.date,
              totalInput: dailyAggregates.totalInput,
              totalOutput: dailyAggregates.totalOutput,
              totalCacheRead: dailyAggregates.totalCacheRead,
              totalCacheWrite: dailyAggregates.totalCacheWrite,
              totalReasoning: dailyAggregates.totalReasoning,
              clientsUsed: dailyAggregates.clientsUsed,
              modelsUsed: dailyAggregates.modelsUsed,
            })
            .from(dailyAggregates)
            .where(eq(dailyAggregates.userId, userId)),
          records: insertedValues,
        })
      : [];

  if (inserted > 0) {
    after(() => recomputeAggregates(db(), userId));
  }

  return Response.json({
    inserted,
    skipped: values.length - inserted,
    total: values.length,
    unlockedBadges,
  });
}
