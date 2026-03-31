import { dailyAggregates, rankings, users } from "@tokenmaxxing/db/index";
import type { Db } from "@tokenmaxxing/db/index";
import { sumAggregateTokens } from "@tokenmaxxing/shared/types";
import { eq, gte, and, inArray, sum } from "drizzle-orm";

type Period = "daily" | "weekly" | "monthly" | "alltime";

function periodStartDate(period: Period): Date | null {
  const now = new Date();
  if (period === "daily")
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
function compositeScore(
  totalTokens: number,
  inputTokens: number,
  outputTokens: number,
  sessionCount: number,
  streak: number
): number {
  const tokenScore = Math.min(1, Math.log10(totalTokens + 1) / 10);
  const efficiency =
    inputTokens > 0 ? Math.min(outputTokens / inputTokens, 2) / 2 : 0;
  const sessionScore = Math.min(1, Math.log10(sessionCount + 1) / 3);
  const streakScore = Math.min(streak / 30, 1);
  return (
    (tokenScore * 0.4 +
      efficiency * 0.25 +
      sessionScore * 0.2 +
      streakScore * 0.15) *
    1000
  );
}

export async function computeRankings(
  db: Db,
  leaderboardId: string,
  period: Period,
  userIds?: string[]
) {
  const startDate = periodStartDate(period);
  const periodStart = startDate?.toISOString().slice(0, 10) ?? "1970-01-01";

  // Aggregate per-user stats for the period
  const conditions = [];
  if (startDate)
    conditions.push(
      gte(dailyAggregates.date, startDate.toISOString().slice(0, 10))
    );
  if (userIds) conditions.push(inArray(dailyAggregates.userId, userIds));

  const userStats = await db
    .select({
      userId: dailyAggregates.userId,
      totalInput: sum(dailyAggregates.totalInput).mapWith(Number),
      totalOutput: sum(dailyAggregates.totalOutput).mapWith(Number),
      totalCacheRead: sum(dailyAggregates.totalCacheRead).mapWith(Number),
      totalCacheWrite: sum(dailyAggregates.totalCacheWrite).mapWith(Number),
      totalReasoning: sum(dailyAggregates.totalReasoning).mapWith(Number),
      totalCost: sum(dailyAggregates.totalCost).mapWith(Number),
      sessionCount: sum(dailyAggregates.sessionCount).mapWith(Number),
    })
    .from(dailyAggregates)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(dailyAggregates.userId);

  // Batch fetch all streaks in one query
  const allUserIds = userStats.map((s) => s.userId);
  const streakRows =
    allUserIds.length > 0
      ? await db
          .select({ id: users.id, streak: users.currentStreak })
          .from(users)
          .where(inArray(users.id, allUserIds))
      : [];
  const userStreaks = new Map(streakRows.map((r) => [r.id, r.streak]));

  // Score and sort
  const scored = userStats
    .map((s) => {
      const totalTokens = sumAggregateTokens(s);
      return {
        userId: s.userId,
        totalTokens,
        totalCost: s.totalCost ?? 0,
        score: compositeScore(
          totalTokens,
          s.totalInput ?? 0,
          s.totalOutput ?? 0,
          s.sessionCount ?? 0,
          userStreaks.get(s.userId) ?? 0
        ),
      };
    })
    .toSorted((a, b) => b.score - a.score);

  // Replace rankings: delete ALL for this (leaderboard, period) to avoid stale snapshots
  await db
    .delete(rankings)
    .where(
      and(
        eq(rankings.leaderboardId, leaderboardId),
        eq(rankings.period, period)
      )
    );

  if (scored.length > 0) {
    await db.insert(rankings).values(
      scored.map((entry, i) => ({
        leaderboardId,
        userId: entry.userId,
        period,
        periodStart,
        rank: i + 1,
        totalTokens: entry.totalTokens,
        totalCost: String(entry.totalCost),
        compositeScore: String(entry.score),
      }))
    );
  }
}

export async function computeAllRankings(
  db: Db,
  orgs?: Array<{ orgId: string; userIds: string[] }>
) {
  const periods: Period[] = ["daily", "weekly", "monthly", "alltime"];

  // Global rankings (all users)
  for (const period of periods) {
    await computeRankings(db, "global", period);
  }

  // Org-scoped rankings
  if (orgs) {
    for (const org of orgs) {
      for (const period of periods) {
        await computeRankings(db, org.orgId, period, org.userIds);
      }
    }
  }
}
