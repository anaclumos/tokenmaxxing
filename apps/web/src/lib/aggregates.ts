import { dailyAggregates, usageRecords, users } from "@tokenmaxxing/db/index";
import type { Db } from "@tokenmaxxing/db/index";
import { sumAggregateTokens } from "@tokenmaxxing/shared/types";
import { eq } from "drizzle-orm";

const ONE_DAY_MS = 86_400_000;

// Count consecutive days ending at the most recent active day (must be today or yesterday)
function computeStreak(dates: string[]): number {
  if (dates.length === 0) return 0;

  const sorted = [...new Set(dates)].toSorted().toReversed(); // unique, newest first
  const latest = new Date(sorted[0]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today.getTime() - ONE_DAY_MS);

  if (latest < yesterday) return 0;

  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]);
    const curr = new Date(sorted[i]);
    if (Math.round((prev.getTime() - curr.getTime()) / ONE_DAY_MS) === 1) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// Recompute daily aggregates for a user from their usage_records
export async function recomputeAggregates(db: Db, userId: string) {
  // Fetch all usage records for this user (flat, no raw SQL)
  const records = await db
    .select({
      timestamp: usageRecords.timestamp,
      inputTokens: usageRecords.inputTokens,
      outputTokens: usageRecords.outputTokens,
      cacheReadTokens: usageRecords.cacheReadTokens,
      cacheWriteTokens: usageRecords.cacheWriteTokens,
      reasoningTokens: usageRecords.reasoningTokens,
      costUsd: usageRecords.costUsd,
      client: usageRecords.client,
      model: usageRecords.model,
    })
    .from(usageRecords)
    .where(eq(usageRecords.userId, userId));

  // Group by date in TypeScript
  const byDate = new Map<
    string,
    {
      totalInput: number;
      totalOutput: number;
      totalCacheRead: number;
      totalCacheWrite: number;
      totalReasoning: number;
      totalCost: number;
      sessionCount: number;
      clients: Set<string>;
      models: Set<string>;
    }
  >();

  for (const r of records) {
    const date = r.timestamp.toISOString().slice(0, 10);
    const existing = byDate.get(date);
    if (existing) {
      existing.totalInput += r.inputTokens;
      existing.totalOutput += r.outputTokens;
      existing.totalCacheRead += r.cacheReadTokens;
      existing.totalCacheWrite += r.cacheWriteTokens;
      existing.totalReasoning += r.reasoningTokens;
      existing.totalCost += Number(r.costUsd);
      existing.sessionCount++;
      existing.clients.add(r.client);
      existing.models.add(r.model);
    } else {
      byDate.set(date, {
        totalInput: r.inputTokens,
        totalOutput: r.outputTokens,
        totalCacheRead: r.cacheReadTokens,
        totalCacheWrite: r.cacheWriteTokens,
        totalReasoning: r.reasoningTokens,
        totalCost: Number(r.costUsd),
        sessionCount: 1,
        clients: new Set([r.client]),
        models: new Set([r.model]),
      });
    }
  }

  // Replace all aggregates
  await db.delete(dailyAggregates).where(eq(dailyAggregates.userId, userId));

  if (byDate.size > 0) {
    await db.insert(dailyAggregates).values(
      [...byDate.entries()].map(([date, d]) => ({
        userId,
        date,
        totalInput: d.totalInput,
        totalOutput: d.totalOutput,
        totalCacheRead: d.totalCacheRead,
        totalCacheWrite: d.totalCacheWrite,
        totalReasoning: d.totalReasoning,
        totalCost: String(d.totalCost),
        sessionCount: d.sessionCount,
        clientsUsed: [...d.clients],
        modelsUsed: [...d.models],
      }))
    );
  }

  // Compute totals
  let totalTokens = 0;
  let totalCost = 0;
  for (const d of byDate.values()) {
    totalTokens += sumAggregateTokens(d);
    totalCost += d.totalCost;
  }

  // Compute streak from dates
  const streak = computeStreak([...byDate.keys()]);

  // Fetch current longest streak, compute new value in TS
  const [user] = await db
    .select({ longestStreak: users.longestStreak })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  await db
    .update(users)
    .set({
      totalTokens,
      totalCost: String(totalCost),
      currentStreak: streak,
      longestStreak: Math.max(user?.longestStreak ?? 0, streak),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}
