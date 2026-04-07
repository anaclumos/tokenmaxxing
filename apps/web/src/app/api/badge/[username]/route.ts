import { users, rankings, dailyAggregates } from "@tokenmaxxing/db/index";
import { getFeaturedBadgeValue } from "@tokenmaxxing/shared/badges";
import { summarizeDailyAggregateRows } from "@tokenmaxxing/shared/daily-aggregate-summary";
import { formatTokens } from "@tokenmaxxing/shared/types";
import { eq, and } from "drizzle-orm";

import { canAccessPrivateUser } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(req: Request, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const { searchParams } = new URL(req.url);
  const style = searchParams.get("style") ?? "tokens"; // tokens | cost | rank | streak | cache | achievement
  const format = searchParams.get("format") ?? "name"; // name | mark

  const [user] = await db()
    .select({
      id: users.id,
      clerkId: users.clerkId,
      totalTokens: users.totalTokens,
      totalCost: users.totalCost,
      currentStreak: users.currentStreak,
      longestStreak: users.longestStreak,
      privacyMode: users.privacyMode,
    })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  const isOwner = user ? await canAccessPrivateUser({ req, user }) : false;
  if (!user || (user.privacyMode && !isOwner)) {
    return Response.json(
      {
        schemaVersion: 1,
        label: "tokenmaxx.ing",
        message: "not found",
        color: "lightgrey",
        isError: true,
      },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );
  }

  let message: string;
  let color: string;
  const needsSummary = style === "cache" || style === "achievement";
  const detail = needsSummary
    ? await db()
        .select({
          date: dailyAggregates.date,
          totalInput: dailyAggregates.totalInput,
          totalOutput: dailyAggregates.totalOutput,
          totalCacheRead: dailyAggregates.totalCacheRead,
          totalCacheWrite: dailyAggregates.totalCacheWrite,
          totalReasoning: dailyAggregates.totalReasoning,
          clientsUsed: dailyAggregates.clientsUsed,
          modelsUsed: dailyAggregates.modelsUsed,
        })
        .from(dailyAggregates)
        .where(eq(dailyAggregates.userId, user.id))
    : [];
  const summary = summarizeDailyAggregateRows({ rows: detail });

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
          eq(rankings.period, "alltime"),
        ),
      )
      .limit(1);
    message = rank ? `#${rank.rank}` : "unranked";
    color = rank ? "brightgreen" : "lightgrey";
  } else if (style === "cache") {
    message = `${summary.cacheHitRate.toFixed(0)}% cache hit`;
    color =
      summary.cacheHitRate >= 50 ? "brightgreen" : summary.cacheHitRate >= 25 ? "yellow" : "orange";
  } else if (style === "achievement") {
    message =
      getFeaturedBadgeValue({
        context: {
          totalTokens: user.totalTokens,
          longestStreak: user.longestStreak,
          clientCount: summary.clients.length,
          modelCount: summary.models.length,
          cacheHitRate: summary.cacheHitRate,
          activeDays: summary.activeDays,
        },
        format: format === "mark" ? "mark" : "name",
      }) ?? "no badges";
    color = message === "no badges" ? "lightgrey" : "blueviolet";
  } else {
    message = `${formatTokens(user.totalTokens)} tokens`;
    color = "brightgreen";
  }

  return Response.json(
    { schemaVersion: 1, label: "tokenmaxx.ing", message, color },
    {
      headers: {
        "Cache-Control":
          user.privacyMode && isOwner ? "private, no-store" : "public, max-age=1800, s-maxage=1800",
        Vary: "Authorization",
      },
    },
  );
}
