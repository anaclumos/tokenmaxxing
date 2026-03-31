import { eq, asc, desc, and, count } from "drizzle-orm";
import { rankings, users } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";
import { LeaderboardTable } from "./leaderboard/leaderboard-table";

type Sort = "score" | "tokens" | "cost";

const orderByColumn = {
  score: asc(rankings.rank),
  tokens: desc(rankings.totalTokens),
  cost: desc(rankings.totalCost),
} as const;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; page?: string; sort?: string }>;
}) {
  const params = await searchParams;
  const period = (params.period ?? "alltime") as "daily" | "weekly" | "monthly" | "alltime";
  const page = Math.max(1, Number(params.page ?? 1));
  const sort: Sort = (["score", "tokens", "cost"] as const).includes(params.sort as Sort) ? (params.sort as Sort) : "score";
  const limit = 50;
  const offset = (page - 1) * limit;

  const where = and(
    eq(rankings.leaderboardId, "global"),
    eq(rankings.period, period),
    eq(users.privacyMode, false),
  );

  const entries = await db()
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
    .where(where)
    .orderBy(orderByColumn[sort])
    .limit(limit)
    .offset(offset);

  // When sorting by tokens/cost, use position as rank
  const numbered = entries.map((e, i) => ({
    ...e,
    rank: sort === "score" ? e.rank : offset + i + 1,
  }));

  const [countRow] = await db()
    .select({ count: count() })
    .from(rankings)
    .innerJoin(users, eq(rankings.userId, users.id))
    .where(where);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Leaderboard</h1>
      <LeaderboardTable entries={numbered} total={countRow?.count ?? 0} period={period} page={page} sort={sort} />
    </main>
  );
}
