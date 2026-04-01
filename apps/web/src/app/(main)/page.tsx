import { rankings, users, usageRecords } from "@tokenmaxxing/db/index";
import { formatTokens } from "@tokenmaxxing/shared/types";
import { SupportedClient } from "@tokenmaxxing/shared/types";
import { eq, asc, desc, and, count, sum, sql, countDistinct } from "drizzle-orm";
import Link from "next/link";

import { db } from "@/lib/db";
import {
  parseLeaderboardPeriod,
  parseLeaderboardSort,
  parsePage,
} from "@/lib/search-params";

import { LeaderboardTable } from "./leaderboard/leaderboard-table";

const orderByColumn = {
  score: asc(rankings.rank),
  tokens: desc(rankings.totalTokens),
  cost: desc(rankings.totalCost),
} as const;

const TOKEN_SUM = sql<number>`sum(${usageRecords.inputTokens} + ${usageRecords.outputTokens} + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens} + ${usageRecords.reasoningTokens})`;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; page?: string; sort?: string; client?: string; model?: string }>;
}) {
  const params = await searchParams;
  const period = parseLeaderboardPeriod(params.period);
  const page = parsePage(params.page);
  const sort = parseLeaderboardSort(params.sort);
  const limit = 50;
  const offset = (page - 1) * limit;

  const clientFilter = params.client && SupportedClient.safeParse(params.client).success ? params.client : undefined;
  const modelFilter = params.model?.trim() || undefined;
  const hasFilter = clientFilter || modelFilter;

  let numbered: Array<{ rank: number; username: string; avatarUrl: string | null; totalTokens: number; totalCost: string; compositeScore: string; streak: number }>;
  let total: number;

  if (hasFilter) {
    // On-the-fly leaderboard from usageRecords filtered by client or model
    const conditions = [eq(users.privacyMode, false)];
    if (clientFilter) conditions.push(eq(usageRecords.client, clientFilter));
    if (modelFilter) conditions.push(eq(usageRecords.model, modelFilter));

    const filteredEntries = await db()
      .select({
        username: users.username,
        avatarUrl: users.avatarUrl,
        totalTokens: TOKEN_SUM.mapWith(Number),
        totalCost: sum(usageRecords.costUsd),
        sessions: count(),
        streak: users.currentStreak,
      })
      .from(usageRecords)
      .innerJoin(users, eq(usageRecords.userId, users.id))
      .where(and(...conditions))
      .groupBy(users.id, users.username, users.avatarUrl, users.currentStreak)
      .orderBy(sort === "cost" ? desc(sum(usageRecords.costUsd)) : desc(TOKEN_SUM))
      .limit(limit)
      .offset(offset);

    numbered = filteredEntries.map((e, i) => ({
      rank: offset + i + 1,
      username: e.username,
      avatarUrl: e.avatarUrl,
      totalTokens: e.totalTokens ?? 0,
      totalCost: String(e.totalCost ?? "0"),
      compositeScore: "0",
      streak: e.streak,
    }));
    total = filteredEntries.length < limit ? offset + filteredEntries.length : offset + limit + 1;
  } else {
    // Pre-computed global leaderboard
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
        .offset(offset),
      db()
        .select({ count: count() })
        .from(rankings)
        .innerJoin(users, eq(rankings.userId, users.id))
        .where(where),
    ]);

    numbered = entries.map((e, i) => ({
      ...e,
      rank: sort === "score" ? e.rank : offset + i + 1,
    }));
    total = countRow?.count ?? 0;
  }

  // Global stats + available clients for filter
  const [globalStats, clientCounts] = await Promise.all([
    db()
      .select({
        totalUsers: count(),
        totalTokens: sum(users.totalTokens).mapWith(Number),
        totalCost: sum(users.totalCost).mapWith(Number),
      })
      .from(users)
      .then((r) => r[0]),
    db()
      .select({
        client: usageRecords.client,
        userCount: countDistinct(usageRecords.userId),
      })
      .from(usageRecords)
      .groupBy(usageRecords.client)
      .orderBy(desc(countDistinct(usageRecords.userId))),
  ]);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Leaderboard</h1>
      <div className="mb-6 flex flex-wrap gap-x-8 gap-y-2 text-sm text-muted-foreground">
        <span>
          <span className="font-mono font-bold text-foreground">
            {globalStats.totalUsers}
          </span>{" "}
          users
        </span>
        <span>
          <span className="font-mono font-bold text-foreground">
            {formatTokens(globalStats.totalTokens ?? 0)}
          </span>{" "}
          tokens
        </span>
        <span>
          <span className="font-mono font-bold text-foreground">
            $
            {(globalStats.totalCost ?? 0).toLocaleString(undefined, {
              maximumFractionDigits: 0,
            })}
          </span>{" "}
          spent
        </span>
      </div>

      {/* Client filter */}
      <div className="mb-4 flex flex-wrap gap-1">
        <Link
          href="/"
          className={`rounded px-2 py-1 text-xs font-mono ${!hasFilter ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          All
        </Link>
        {clientCounts.map((c) => (
          <Link
            key={c.client}
            href={`/?client=${c.client}`}
            className={`rounded px-2 py-1 text-xs font-mono ${clientFilter === c.client ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {c.client}
          </Link>
        ))}
      </div>

      <LeaderboardTable
        entries={numbered}
        total={total}
        period={period}
        page={page}
        sort={hasFilter ? (sort === "score" ? "tokens" : sort) : sort}
        filter={hasFilter ? { client: clientFilter, model: modelFilter } : undefined}
      />
    </main>
  );
}
