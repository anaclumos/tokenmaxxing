import { eq, asc, and, count } from "drizzle-orm";
import { rankings, users } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";
import { LeaderboardTable } from "./leaderboard-table";

export const metadata = { title: "Leaderboard - tokenmaxx.ing" };

type Period = "daily" | "weekly" | "monthly" | "alltime";

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; page?: string }>;
}) {
  const params = await searchParams;
  const period = (params.period ?? "alltime") as Period;
  const page = Math.max(1, Number(params.page ?? 1));
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
    .orderBy(asc(rankings.rank))
    .limit(limit)
    .offset(offset);

  const [countRow] = await db()
    .select({ count: count() })
    .from(rankings)
    .innerJoin(users, eq(rankings.userId, users.id))
    .where(where);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Leaderboard</h1>
      <LeaderboardTable entries={entries} total={countRow?.count ?? 0} period={period} page={page} />
    </main>
  );
}
