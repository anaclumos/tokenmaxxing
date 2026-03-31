import { eq, asc, sql, and } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { rankings, users } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const period = searchParams.get("period") ?? "alltime";
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 50)));
  const offset = (page - 1) * limit;

  const rows = await db()
    .select({
      rank: rankings.rank,
      username: users.username,
      avatarUrl: users.avatarUrl,
      totalTokens: rankings.totalTokens,
      totalCost: rankings.totalCost,
      compositeScore: rankings.compositeScore,
      streak: users.currentStreak,
    })
    .from(rankings)
    .innerJoin(users, eq(rankings.userId, users.id))
    .where(
      and(
        eq(rankings.leaderboardId, "global"),
        sql`${rankings.period} = ${period}`,
        eq(users.privacyMode, false),
      ),
    )
    .orderBy(asc(rankings.rank))
    .limit(limit)
    .offset(offset);

  const [countRow] = await db()
    .select({ count: sql<number>`COUNT(*)`.as("count") })
    .from(rankings)
    .innerJoin(users, eq(rankings.userId, users.id))
    .where(
      and(
        eq(rankings.leaderboardId, "global"),
        sql`${rankings.period} = ${period}`,
        eq(users.privacyMode, false),
      ),
    );

  return Response.json(
    { entries: rows, total: countRow?.count ?? 0, page, period },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30" } },
  );
}
