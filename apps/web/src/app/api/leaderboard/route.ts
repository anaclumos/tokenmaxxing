import { rankings, users } from "@tokenmaxxing/db/index";
import { eq, asc, desc, and, count, sum } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  parseLeaderboardPeriod,
  parseLeaderboardSort,
  parsePage,
} from "@/lib/search-params";

const orderByColumn = {
  score: asc(rankings.rank),
  tokens: desc(rankings.totalTokens),
  cost: desc(rankings.totalCost),
} as const;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const period = parseLeaderboardPeriod(url.searchParams.get("period") ?? undefined);
  const page = parsePage(url.searchParams.get("page") ?? undefined);
  const sort = parseLeaderboardSort(url.searchParams.get("sort") ?? undefined);
  const limit = 50;
  const offset = (page - 1) * limit;

  const where = and(
    eq(rankings.leaderboardId, "global"),
    eq(rankings.period, period),
    eq(users.privacyMode, false)
  );

  const [entries, [countRow], [globalStats]] = await Promise.all([
    db()
      .select({
        rank: rankings.rank,
        username: users.username,
        totalTokens: rankings.totalTokens,
        totalCost: rankings.totalCost,
        compositeScore: rankings.compositeScore,
        streak: users.currentStreak,
      })
      .from(rankings)
      .innerJoin(users, eq(rankings.userId, users.id))
      .where(where)
      .orderBy(orderByColumn[sort])
      .limit(limit)
      .offset(offset),
    db()
      .select({ count: count() })
      .from(rankings)
      .innerJoin(users, eq(rankings.userId, users.id))
      .where(where),
    db()
      .select({
        totalUsers: count(),
        totalTokens: sum(users.totalTokens).mapWith(Number),
        totalCost: sum(users.totalCost).mapWith(Number),
      })
      .from(users),
  ]);

  const numbered = entries.map((e, i) => ({
    rank: sort === "score" ? e.rank : offset + i + 1,
    username: e.username,
    totalTokens: e.totalTokens,
    totalCost: Number(e.totalCost),
    compositeScore: Number(e.compositeScore),
    streak: e.streak,
  }));

  return Response.json({
    period,
    sort,
    page,
    totalEntries: countRow?.count ?? 0,
    totalPages: Math.ceil((countRow?.count ?? 0) / limit),
    global: {
      totalUsers: globalStats.totalUsers,
      totalTokens: globalStats.totalTokens ?? 0,
      totalCost: globalStats.totalCost ?? 0,
    },
    entries: numbered,
  }, {
    headers: {
      "Cache-Control": "public, max-age=60, s-maxage=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
