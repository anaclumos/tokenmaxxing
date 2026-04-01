import { users, rankings, dailyAggregates } from "@tokenmaxxing/db/index";
import { formatTokens } from "@tokenmaxxing/shared/types";
import { eq, and, sum } from "drizzle-orm";

import { db } from "@/lib/db";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ username: string }> }
) {
  const { username } = await params;
  const { searchParams } = new URL(req.url);
  const style = searchParams.get("style") ?? "tokens"; // tokens | cost | rank | streak | cache

  const [user] = await db()
    .select({
      id: users.id,
      totalTokens: users.totalTokens,
      totalCost: users.totalCost,
      currentStreak: users.currentStreak,
      privacyMode: users.privacyMode,
    })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user || user.privacyMode) {
    return Response.json(
      {
        schemaVersion: 1,
        label: "tokenmaxx.ing",
        message: "not found",
        color: "lightgrey",
        isError: true,
      },
      { headers: { "Cache-Control": "public, max-age=300" } }
    );
  }

  let message: string;
  let color: string;

  if (style === "cost") {
    message = `$${Number(user.totalCost).toFixed(2)}`;
    color = "blue";
  } else if (style === "streak") {
    message = `${user.currentStreak}d streak`;
    color = user.currentStreak > 0 ? "orange" : "lightgrey";
  } else if (style === "rank") {
    const [rank] = await db()
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
    message = rank ? `#${rank.rank}` : "unranked";
    color = rank ? "brightgreen" : "lightgrey";
  } else if (style === "cache") {
    const [agg] = await db()
      .select({
        totalInput: sum(dailyAggregates.totalInput).mapWith(Number),
        totalCacheRead: sum(dailyAggregates.totalCacheRead).mapWith(Number),
      })
      .from(dailyAggregates)
      .where(eq(dailyAggregates.userId, user.id));
    const input = agg?.totalInput ?? 0;
    const cacheRead = agg?.totalCacheRead ?? 0;
    const pool = input + cacheRead;
    const rate = pool > 0 ? (cacheRead / pool) * 100 : 0;
    message = `${rate.toFixed(0)}% cache hit`;
    color = rate >= 50 ? "brightgreen" : rate >= 25 ? "yellow" : "orange";
  } else {
    message = `${formatTokens(user.totalTokens)} tokens`;
    color = "brightgreen";
  }

  return Response.json(
    { schemaVersion: 1, label: "tokenmaxx.ing", message, color },
    { headers: { "Cache-Control": "public, max-age=1800, s-maxage=1800" } }
  );
}
