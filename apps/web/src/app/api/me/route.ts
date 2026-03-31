import { eq, desc, and } from "drizzle-orm";
import { users, dailyAggregates, rankings } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";
import { authenticateToken } from "@/lib/auth";

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

  // Get global rank
  const [globalRank] = await db()
    .select({ rank: rankings.rank, totalTokens: rankings.totalTokens })
    .from(rankings)
    .where(
      and(eq(rankings.leaderboardId, "global"), eq(rankings.userId, user.id), eq(rankings.period, "alltime")),
    )
    .limit(1);

  // Recent 30 days of activity
  const activityRows = await db()
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
    .limit(30);

  const activity = activityRows.map((a) => ({
    date: a.date,
    tokens: a.totalInput + a.totalOutput + a.totalCacheRead + a.totalCacheWrite + a.totalReasoning,
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
