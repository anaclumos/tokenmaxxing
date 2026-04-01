import { users, rankings } from "@tokenmaxxing/db/index";
import { eq, and } from "drizzle-orm";

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

  const [globalRank] = await db()
    .select({ rank: rankings.rank })
    .from(rankings)
    .where(
      and(
        eq(rankings.leaderboardId, "global"),
        eq(rankings.userId, user.id),
        eq(rankings.period, "alltime")
      )
    )
    .limit(1);

  return Response.json({
    user: {
      username: user.username,
      totalTokens: user.totalTokens,
      totalCost: user.totalCost,
      streak: user.currentStreak,
      longestStreak: user.longestStreak,
    },
    ranks: {
      global: globalRank ? { rank: globalRank.rank } : null,
    },
  });
}
