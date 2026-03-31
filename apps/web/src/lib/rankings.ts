import { sql, eq, gte, and } from "drizzle-orm";
import { dailyAggregates, rankings, users } from "@tokenmaxxing/db/index";
import type { Db } from "@tokenmaxxing/db/index";

type Period = "daily" | "weekly" | "monthly" | "alltime";

function periodStartDate(period: Period): Date | null {
  const now = new Date();
  if (period === "daily") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "weekly") {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return d;
  }
  if (period === "monthly") {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return d;
  }
  return null; // alltime
}

// Composite score: token volume 40%, efficiency 25%, sessions 20%, streak 15%
function compositeScore(totalTokens: number, inputTokens: number, outputTokens: number, sessionCount: number, streak: number): number {
  const tokenScore = Math.min(1, Math.log10(totalTokens + 1) / 10);
  const efficiency = inputTokens > 0 ? Math.min(outputTokens / inputTokens, 2) / 2 : 0;
  const sessionScore = Math.min(1, Math.log10(sessionCount + 1) / 3);
  const streakScore = Math.min(streak / 30, 1);
  return (tokenScore * 0.4 + efficiency * 0.25 + sessionScore * 0.2 + streakScore * 0.15) * 1000;
}

export async function computeRankings(db: Db, leaderboardId: string, period: Period) {
  const startDate = periodStartDate(period);
  const periodStart = startDate?.toISOString().slice(0, 10) ?? "1970-01-01";

  // Aggregate per-user stats for the period
  const dateFilter = startDate
    ? gte(dailyAggregates.date, startDate.toISOString().slice(0, 10))
    : sql`TRUE`;

  const userStats = await db
    .select({
      userId: dailyAggregates.userId,
      totalTokens: sql<number>`SUM(${dailyAggregates.totalInput} + ${dailyAggregates.totalOutput} + ${dailyAggregates.totalCacheRead} + ${dailyAggregates.totalCacheWrite} + ${dailyAggregates.totalReasoning})`.as("total_tokens"),
      totalInput: sql<number>`SUM(${dailyAggregates.totalInput})`.as("total_input"),
      totalOutput: sql<number>`SUM(${dailyAggregates.totalOutput})`.as("total_output"),
      totalCost: sql<number>`SUM(${dailyAggregates.totalCost}::numeric)`.as("total_cost"),
      sessionCount: sql<number>`SUM(${dailyAggregates.sessionCount})`.as("session_count"),
    })
    .from(dailyAggregates)
    .where(dateFilter)
    .groupBy(dailyAggregates.userId);

  // Get streaks for each user
  const userStreaks = new Map<string, number>();
  for (const stat of userStats) {
    const [row] = await db
      .select({ streak: users.currentStreak })
      .from(users)
      .where(eq(users.id, stat.userId))
      .limit(1);
    userStreaks.set(stat.userId, row?.streak ?? 0);
  }

  // Score and sort
  const scored = userStats
    .map((s) => ({
      userId: s.userId,
      totalTokens: s.totalTokens,
      totalCost: s.totalCost,
      score: compositeScore(
        s.totalTokens,
        s.totalInput,
        s.totalOutput,
        s.sessionCount,
        userStreaks.get(s.userId) ?? 0,
      ),
    }))
    .sort((a, b) => b.score - a.score);

  // Upsert rankings
  for (let i = 0; i < scored.length; i++) {
    const entry = scored[i];
    await db
      .insert(rankings)
      .values({
        leaderboardId,
        userId: entry.userId,
        period,
        periodStart,
        rank: i + 1,
        totalTokens: entry.totalTokens,
        totalCost: String(entry.totalCost),
        compositeScore: String(entry.score),
      })
      .onConflictDoUpdate({
        target: [rankings.leaderboardId, rankings.userId, rankings.period, rankings.periodStart],
        set: {
          rank: i + 1,
          totalTokens: entry.totalTokens,
          totalCost: String(entry.totalCost),
          compositeScore: String(entry.score),
        },
      });
  }
}

export async function computeAllRankings(db: Db) {
  const periods: Period[] = ["daily", "weekly", "monthly", "alltime"];
  for (const period of periods) {
    await computeRankings(db, "global", period);
  }
}
