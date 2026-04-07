import { users, dailyAggregates, rankings } from "@tokenmaxxing/db/index";
import { getEarnedBadges } from "@tokenmaxxing/shared/badges";
import { sumAggregateTokens } from "@tokenmaxxing/shared/types";
import { eq, desc, and } from "drizzle-orm";

import { db } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;

  const [user] = await db()
    .select({
      totalTokens: users.totalTokens,
      totalCost: users.totalCost,
      currentStreak: users.currentStreak,
      longestStreak: users.longestStreak,
      privacyMode: users.privacyMode,
      id: users.id,
    })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user || user.privacyMode) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  const [[globalRank], activityRows] = await Promise.all([
    db()
      .select({ rank: rankings.rank, compositeScore: rankings.compositeScore })
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
        cost: dailyAggregates.totalCost,
        clientsUsed: dailyAggregates.clientsUsed,
        modelsUsed: dailyAggregates.modelsUsed,
      })
      .from(dailyAggregates)
      .where(eq(dailyAggregates.userId, user.id))
      .orderBy(desc(dailyAggregates.date)),
  ]);

  const breakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const allModels = new Set<string>();
  const allClients = new Set<string>();
  for (const a of activityRows) {
    breakdown.input += a.totalInput;
    breakdown.output += a.totalOutput;
    breakdown.cacheRead += a.totalCacheRead;
    breakdown.cacheWrite += a.totalCacheWrite;
    breakdown.reasoning += a.totalReasoning;
    for (const m of a.modelsUsed) allModels.add(m);
    for (const c of a.clientsUsed) allClients.add(c);
  }

  const cachePool = breakdown.input + breakdown.cacheRead;
  const cacheHitRate =
    cachePool > 0 ? Number(((breakdown.cacheRead / cachePool) * 100).toFixed(1)) : 0;
  const badges = getEarnedBadges({
    context: {
      totalTokens: user.totalTokens,
      longestStreak: user.longestStreak,
      clientCount: allClients.size,
      modelCount: allModels.size,
      cacheHitRate,
      activeDays: activityRows.length,
    },
  });

  return Response.json(
    {
      username,
      totalTokens: user.totalTokens,
      totalCost: Number(user.totalCost),
      streak: user.currentStreak,
      longestStreak: user.longestStreak,
      rank: globalRank?.rank ?? null,
      score: globalRank ? Number(globalRank.compositeScore) : null,
      tokens: breakdown,
      cacheHitRate,
      models: [...allModels].toSorted(),
      clients: [...allClients].toSorted(),
      badges,
      activity: activityRows.map((a) => ({
        date: a.date,
        tokens: sumAggregateTokens(a),
        cost: Number(a.cost),
      })),
    },
    {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=300",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
