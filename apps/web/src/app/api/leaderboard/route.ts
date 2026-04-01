import { rankings, users, usageRecords } from "@tokenmaxxing/db/index";
import { SupportedClient } from "@tokenmaxxing/shared/types";
import { eq, asc, desc, and, count, sum } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  parseLeaderboardPeriod,
  parseLeaderboardSort,
  parsePage,
} from "@/lib/search-params";
import { TOKEN_SUM } from "@/lib/usage-queries";

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

  const clientFilter = url.searchParams.get("client");
  const modelFilter = url.searchParams.get("model");
  const hasFilter = (clientFilter && SupportedClient.safeParse(clientFilter).success) || modelFilter;

  if (hasFilter) {
    const conditions = [eq(users.privacyMode, false)];
    if (clientFilter && SupportedClient.safeParse(clientFilter).success) conditions.push(eq(usageRecords.client, clientFilter));
    if (modelFilter) conditions.push(eq(usageRecords.model, modelFilter));

    const entries = await db()
      .select({
        username: users.username,
        totalTokens: TOKEN_SUM.mapWith(Number),
        totalCost: sum(usageRecords.costUsd).mapWith(Number),
        sessions: count(),
        streak: users.currentStreak,
      })
      .from(usageRecords)
      .innerJoin(users, eq(usageRecords.userId, users.id))
      .where(and(...conditions))
      .groupBy(users.id, users.username, users.currentStreak)
      .orderBy(sort === "cost" ? desc(sum(usageRecords.costUsd)) : desc(TOKEN_SUM))
      .limit(limit)
      .offset(offset);

    return Response.json({
      filter: { client: clientFilter, model: modelFilter },
      sort: sort === "score" ? "tokens" : sort,
      page,
      entries: entries.map((e, i) => ({
        rank: offset + i + 1,
        username: e.username,
        totalTokens: e.totalTokens ?? 0,
        totalCost: e.totalCost ?? 0,
        sessions: e.sessions,
        streak: e.streak,
      })),
    }, {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=60",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const where = and(
    eq(rankings.leaderboardId, "global"),
    eq(rankings.period, period),
    eq(users.privacyMode, false)
  );

  const [entries, [countRow]] = await Promise.all([
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
  ]);

  return Response.json({
    period,
    sort,
    page,
    totalEntries: countRow?.count ?? 0,
    totalPages: Math.ceil((countRow?.count ?? 0) / limit),
    entries: entries.map((e, i) => ({
      rank: sort === "score" ? e.rank : offset + i + 1,
      username: e.username,
      totalTokens: e.totalTokens,
      totalCost: Number(e.totalCost),
      compositeScore: Number(e.compositeScore),
      streak: e.streak,
    })),
  }, {
    headers: {
      "Cache-Control": "public, max-age=60, s-maxage=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
