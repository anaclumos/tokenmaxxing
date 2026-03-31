import { users, dailyAggregates, rankings } from "@tokenmaxxing/db/index";
import { sumAggregateTokens } from "@tokenmaxxing/shared/types";
import { eq, desc, and } from "drizzle-orm";

import { authenticateToken } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  const userId = await authenticateToken(req);
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [user] = await db()
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  const [[globalRank], activityRows] = await Promise.all([
    db()
      .select({ rank: rankings.rank })
      .from(rankings)
      .where(
        and(
          eq(rankings.leaderboardId, "global"),
          eq(rankings.userId, user.id),
          eq(rankings.period, "alltime")
        )
      )
      .limit(1),
    db()
      .select({
        date: dailyAggregates.date,
        totalInput: dailyAggregates.totalInput,
        totalOutput: dailyAggregates.totalOutput,
        totalCacheRead: dailyAggregates.totalCacheRead,
        totalCacheWrite: dailyAggregates.totalCacheWrite,
        totalReasoning: dailyAggregates.totalReasoning,
        cost: dailyAggregates.totalCost,
      })
      .from(dailyAggregates)
      .where(eq(dailyAggregates.userId, user.id))
      .orderBy(desc(dailyAggregates.date))
      .limit(30),
  ]);

  const activity = activityRows.map((a) => ({
    date: a.date,
    tokens: sumAggregateTokens(a),
    cost: a.cost,
  }));

  return Response.json({
    user: {
      username: user.username,
      avatarUrl: user.avatarUrl,
      totalTokens: user.totalTokens,
      totalCost: user.totalCost,
      streak: user.currentStreak,
      longestStreak: user.longestStreak,
    },
    ranks: {
      global: globalRank ? { rank: globalRank.rank } : null,
    },
    recentActivity: activity,
  });
}
