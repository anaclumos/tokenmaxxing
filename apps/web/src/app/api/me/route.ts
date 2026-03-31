import { auth } from "@clerk/nextjs/server";
import { eq, desc, sql } from "drizzle-orm";
import { users, dailyAggregates, rankings } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";

export async function GET() {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [user] = await db()
    .select()
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (!user) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  // Get global rank
  const [globalRank] = await db()
    .select({ rank: rankings.rank, totalTokens: rankings.totalTokens })
    .from(rankings)
    .where(
      sql`${rankings.leaderboardId} = 'global' AND ${rankings.userId} = ${user.id} AND ${rankings.period} = 'alltime'`,
    )
    .limit(1);

  // Recent 30 days of activity
  const activity = await db()
    .select({
      date: dailyAggregates.date,
      tokens: sql<number>`${dailyAggregates.totalInput} + ${dailyAggregates.totalOutput} + ${dailyAggregates.totalCacheRead} + ${dailyAggregates.totalCacheWrite} + ${dailyAggregates.totalReasoning}`.as("tokens"),
      cost: dailyAggregates.totalCost,
    })
    .from(dailyAggregates)
    .where(eq(dailyAggregates.userId, user.id))
    .orderBy(desc(dailyAggregates.date))
    .limit(30);

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
