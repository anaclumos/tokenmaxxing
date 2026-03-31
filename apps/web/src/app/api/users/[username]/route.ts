import { eq, desc, sql } from "drizzle-orm";
import { users, dailyAggregates, rankings } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;

  const [user] = await db()
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user || user.privacyMode) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const [globalRank] = await db()
    .select({ rank: rankings.rank, compositeScore: rankings.compositeScore })
    .from(rankings)
    .where(
      sql`${rankings.leaderboardId} = 'global' AND ${rankings.userId} = ${user.id} AND ${rankings.period} = 'alltime'`,
    )
    .limit(1);

  const activity = await db()
    .select({
      date: dailyAggregates.date,
      tokens: sql<number>`${dailyAggregates.totalInput} + ${dailyAggregates.totalOutput} + ${dailyAggregates.totalCacheRead} + ${dailyAggregates.totalCacheWrite} + ${dailyAggregates.totalReasoning}`.as("tokens"),
      cost: dailyAggregates.totalCost,
      clientsUsed: dailyAggregates.clientsUsed,
    })
    .from(dailyAggregates)
    .where(eq(dailyAggregates.userId, user.id))
    .orderBy(desc(dailyAggregates.date))
    .limit(365);

  return Response.json({
    username: user.username,
    avatarUrl: user.avatarUrl,
    totalTokens: user.totalTokens,
    totalCost: user.totalCost,
    streak: user.currentStreak,
    longestStreak: user.longestStreak,
    globalRank: globalRank ? { rank: globalRank.rank, score: globalRank.compositeScore } : null,
    activity,
  });
}
