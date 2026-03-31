import { eq, sql } from "drizzle-orm";
import { dailyAggregates, usageRecords, users } from "@tokenmaxxing/db/index";
import type { Db } from "@tokenmaxxing/db/index";

// Recompute daily aggregates for a user from their usage_records
export async function recomputeAggregates(db: Db, userId: string) {
  // Group usage records by date
  const rows = await db
    .select({
      date: sql<string>`DATE(${usageRecords.timestamp})`.as("date"),
      totalInput: sql<number>`SUM(${usageRecords.inputTokens})`.as("total_input"),
      totalOutput: sql<number>`SUM(${usageRecords.outputTokens})`.as("total_output"),
      totalCacheRead: sql<number>`SUM(${usageRecords.cacheReadTokens})`.as("total_cache_read"),
      totalCacheWrite: sql<number>`SUM(${usageRecords.cacheWriteTokens})`.as("total_cache_write"),
      totalReasoning: sql<number>`SUM(${usageRecords.reasoningTokens})`.as("total_reasoning"),
      totalCost: sql<number>`SUM(${usageRecords.costUsd}::numeric)`.as("total_cost"),
      sessionCount: sql<number>`COUNT(*)`.as("session_count"),
      clientsUsed: sql<string[]>`ARRAY_AGG(DISTINCT ${usageRecords.client})`.as("clients_used"),
      modelsUsed: sql<string[]>`ARRAY_AGG(DISTINCT ${usageRecords.model})`.as("models_used"),
    })
    .from(usageRecords)
    .where(eq(usageRecords.userId, userId))
    .groupBy(sql`DATE(${usageRecords.timestamp})`);

  // Replace all aggregates: delete old, batch insert new (2 queries instead of N upserts)
  await db.delete(dailyAggregates).where(eq(dailyAggregates.userId, userId));

  if (rows.length > 0) {
    await db.insert(dailyAggregates).values(
      rows.map((row) => ({
        userId,
        date: row.date,
        totalInput: row.totalInput,
        totalOutput: row.totalOutput,
        totalCacheRead: row.totalCacheRead,
        totalCacheWrite: row.totalCacheWrite,
        totalReasoning: row.totalReasoning,
        totalCost: String(row.totalCost),
        sessionCount: row.sessionCount,
        clientsUsed: row.clientsUsed,
        modelsUsed: row.modelsUsed,
      })),
    );
  }

  // Compute totals from data we already have (no redundant query)
  let totalTokens = 0;
  let totalCost = 0;
  for (const row of rows) {
    totalTokens += row.totalInput + row.totalOutput + row.totalCacheRead + row.totalCacheWrite + row.totalReasoning;
    totalCost += row.totalCost;
  }

  // Compute streak: consecutive days ending at most recent active day
  const streakResult = await db.execute(sql`
    WITH dates AS (
      SELECT DISTINCT DATE(${usageRecords.timestamp}) as d
      FROM ${usageRecords}
      WHERE ${usageRecords.userId} = ${userId}
    ),
    recent AS (
      SELECT MAX(d) as latest FROM dates WHERE d >= CURRENT_DATE - 1
    ),
    numbered AS (
      SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d))::int * INTERVAL '1 day' AS grp
      FROM dates
    )
    SELECT COUNT(*) as streak
    FROM numbered, recent
    WHERE grp = (SELECT grp FROM numbered WHERE d = recent.latest)
  `);

  const streak = Number(streakResult.rows?.[0]?.streak ?? 0);

  await db
    .update(users)
    .set({
      totalTokens,
      totalCost: String(totalCost),
      currentStreak: streak,
      longestStreak: sql`GREATEST(${users.longestStreak}, ${streak})`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}
