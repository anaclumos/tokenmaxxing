import { dailyAggregates, rankings, usageRecords, users } from "@tokenmaxxing/db/index";
import { sumAggregateTokens } from "@tokenmaxxing/shared/types";
import {
  computeLongestStreak,
  getYearRange,
  parseWrappedYear,
  renderWrappedSvg,
  renderWrappedUnavailableSvg,
} from "@tokenmaxxing/shared/wrapped";
import { getEarnedBadges } from "@tokenmaxxing/shared/badges";
import { and, count, desc, eq, gte, lt } from "drizzle-orm";

import { authenticateToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { TOKEN_SUM } from "@/lib/usage-queries";

export async function GET(req: Request, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const year = parseWrappedYear({
    value: new URL(req.url).searchParams.get("year") ?? undefined,
  });
  const { startDate, endDate, startTime, endTime } = getYearRange({ year });
  const requesterId = await authenticateToken(req);

  const [user] = await db()
    .select({
      id: users.id,
      username: users.username,
      privacyMode: users.privacyMode,
    })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  const isOwnerRequest = requesterId === user?.id;
  if (!user || (user.privacyMode && !isOwnerRequest)) {
    const svg = renderWrappedUnavailableSvg({ username });
    return new Response(svg, {
      status: 404,
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  const [[globalRank], activityRows, topClientRows, topModelRows] = await Promise.all([
    db()
      .select({ rank: rankings.rank })
      .from(rankings)
      .where(
        and(
          eq(rankings.leaderboardId, "global"),
          eq(rankings.userId, user.id),
          eq(rankings.period, "alltime"),
        ),
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
        totalCost: dailyAggregates.totalCost,
        sessionCount: dailyAggregates.sessionCount,
      })
      .from(dailyAggregates)
      .where(
        and(
          eq(dailyAggregates.userId, user.id),
          gte(dailyAggregates.date, startDate),
          lt(dailyAggregates.date, endDate),
        ),
      )
      .orderBy(desc(dailyAggregates.date)),
    db()
      .select({
        label: usageRecords.client,
        messages: count(),
      })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.userId, user.id),
          gte(usageRecords.timestamp, startTime),
          lt(usageRecords.timestamp, endTime),
        ),
      )
      .groupBy(usageRecords.client)
      .orderBy(desc(count()), desc(TOKEN_SUM))
      .limit(3),
    db()
      .select({
        label: usageRecords.model,
        messages: count(),
      })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.userId, user.id),
          gte(usageRecords.timestamp, startTime),
          lt(usageRecords.timestamp, endTime),
        ),
      )
      .groupBy(usageRecords.model)
      .orderBy(desc(count()), desc(TOKEN_SUM))
      .limit(3),
  ]);

  const activityMap = new Map<string, number>();
  let totalTokens = 0;
  let totalCost = 0;
  let messages = 0;
  let totalInput = 0;
  let totalCacheRead = 0;

  for (const activity of activityRows) {
    const dayTokens = sumAggregateTokens(activity);
    activityMap.set(activity.date, dayTokens);
    totalTokens += dayTokens;
    totalCost += Number(activity.totalCost);
    messages += activity.sessionCount;
    totalInput += activity.totalInput;
    totalCacheRead += activity.totalCacheRead;
  }

  const longestStreak = computeLongestStreak({
    dates: activityRows.map((activity) => activity.date),
  });
  const cachePool = totalInput + totalCacheRead;

  const svg = renderWrappedSvg({
    data: {
      username: user.username,
      year,
      totalTokens,
      totalCost,
      activeDays: activityRows.length,
      messages,
      longestStreak,
      rank: globalRank?.rank ?? null,
      topClients: topClientRows.map((row) => row.label),
      topModels: topModelRows.map((row) => row.label),
      activityMap,
      badges: getEarnedBadges({
        context: {
          totalTokens,
          longestStreak,
          clientCount: topClientRows.length,
          modelCount: topModelRows.length,
          cacheHitRate: cachePool > 0 ? (totalCacheRead / cachePool) * 100 : 0,
          activeDays: activityRows.length,
        },
      }),
    },
  });

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control":
        user.privacyMode && isOwnerRequest
          ? "private, no-store"
          : "public, max-age=1800, s-maxage=1800",
      Vary: "Authorization",
    },
  });
}
