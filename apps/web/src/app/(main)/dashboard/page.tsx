import { auth } from "@clerk/nextjs/server";
import { users, dailyAggregates, rankings, usageRecords } from "@tokenmaxxing/db/index";
import { formatTokens, sumAggregateTokens } from "@tokenmaxxing/shared/types";
import { Badge } from "@tokenmaxxing/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@tokenmaxxing/ui/components/card";
import { ActivityHeatmap } from "@tokenmaxxing/ui/components/heatmap";
import { eq, desc, and, sum, count, isNotNull, sql } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { queryClientActivity, queryDayBreakdown } from "@/lib/usage-queries";

export const metadata = { title: "Dashboard - tokenmaxx.ing" };

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; client?: string; day?: string }>;
}) {
  const params = await searchParams;
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/sign-in");

  const [user] = await db()
    .select()
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (!user) redirect("/sign-in");

  const [[globalRank], activityRows, modelStats, projectStats] = await Promise.all([
    db()
      .select({ rank: rankings.rank })
      .from(rankings)
      .where(
        and(
          eq(rankings.leaderboardId, "global"),
          eq(rankings.userId, user.id),
          eq(rankings.period, "alltime")
        )
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
        sessions: dailyAggregates.sessionCount,
        clientsUsed: dailyAggregates.clientsUsed,
      })
      .from(dailyAggregates)
      .where(eq(dailyAggregates.userId, user.id))
      .orderBy(desc(dailyAggregates.date)),
    db()
      .select({
        model: usageRecords.model,
        sessions: count(),
        totalCost: sum(usageRecords.costUsd).mapWith(Number),
      })
      .from(usageRecords)
      .where(eq(usageRecords.userId, user.id))
      .groupBy(usageRecords.model)
      .orderBy(desc(sum(usageRecords.costUsd))),
    db()
      .select({
        project: usageRecords.project,
        sessions: count(),
        totalCost: sum(usageRecords.costUsd).mapWith(Number),
        totalTokens: sql<number>`sum(${usageRecords.inputTokens} + ${usageRecords.outputTokens} + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens} + ${usageRecords.reasoningTokens})`.mapWith(Number),
      })
      .from(usageRecords)
      .where(and(eq(usageRecords.userId, user.id), isNotNull(usageRecords.project)))
      .groupBy(usageRecords.project)
      .orderBy(desc(sum(usageRecords.costUsd))),
  ]);

  const activity = activityRows.map((a) => ({
    ...a,
    tokens: sumAggregateTokens(a),
  }));

  // Client filter
  const allClients = [...new Set(activityRows.flatMap((a) => a.clientsUsed))].toSorted();
  const selectedClient = params.client && allClients.includes(params.client) ? params.client : undefined;

  // When filtering by client, query usageRecords grouped by date
  const clientActivity = selectedClient ? await queryClientActivity(user.id, selectedClient) : null;

  // Day detail breakdown
  const selectedDay = params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : undefined;
  const dayDetail = selectedDay ? await queryDayBreakdown(user.id, selectedDay) : null;

  // Year selector
  const availableYears = [...new Set(activityRows.map((a) => Number(a.date.slice(0, 4))))].toSorted((a, b) => b - a);
  const selectedYear = params.year ? Number(params.year) : undefined;

  const baseHeatmap = clientActivity ?? activity.map((a) => ({ date: a.date, tokens: a.tokens }));
  const heatmapData = selectedYear
    ? baseHeatmap.filter((a) => a.date.startsWith(String(selectedYear)))
    : baseHeatmap;

  // Single pass: accumulate cost and cache stats by time bucket
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);

  const acc = { cost: [0, 0], input: [0, 0, 0], cacheRead: [0, 0, 0] };
  //           recent/prev       all/recent/prev

  for (const a of activityRows) {
    const cost = Number(a.cost);
    if (a.date >= sevenDaysAgo) {
      acc.cost[0] += cost;
      acc.input[1] += a.totalInput;
      acc.cacheRead[1] += a.totalCacheRead;
    } else if (a.date >= fourteenDaysAgo) {
      acc.cost[1] += cost;
      acc.input[2] += a.totalInput;
      acc.cacheRead[2] += a.totalCacheRead;
    }
    acc.input[0] += a.totalInput;
    acc.cacheRead[0] += a.totalCacheRead;
  }

  const [recentCost, prevCost] = acc.cost;
  const [totalInput, recentInput, prevInput] = acc.input;
  const [totalCacheRead, recentCacheRead, prevCacheRead] = acc.cacheRead;

  // Burn rate projection
  const dailyRate = recentCost / 7;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projectedMonthly = dailyRate * daysInMonth;
  const trend = prevCost > 0 ? ((recentCost - prevCost) / prevCost) * 100 : 0;

  // Model efficiency analysis
  const totalModelCost = modelStats.reduce((s, m) => s + (m.totalCost ?? 0), 0);
  const isExpensiveModel = (name: string) => {
    const lower = name.toLowerCase();
    return lower.includes("opus") || lower.includes("gpt-5") ||
      lower.startsWith("o1") || lower.startsWith("o3");
  };
  const expensiveCost = modelStats
    .filter((m) => isExpensiveModel(m.model))
    .reduce((s, m) => s + (m.totalCost ?? 0), 0);
  const expensiveRatio = totalModelCost > 0 ? (expensiveCost / totalModelCost) * 100 : 0;

  // Cache efficiency: cacheRead / (input + cacheRead)
  const cachePool = totalInput + totalCacheRead;
  const cacheHitRate = cachePool > 0 ? (totalCacheRead / cachePool) * 100 : 0;
  const recentPool = recentInput + recentCacheRead;
  const recentCacheRate = recentPool > 0 ? (recentCacheRead / recentPool) * 100 : 0;
  const prevPool = prevInput + prevCacheRead;
  const prevCacheRate = prevPool > 0 ? (prevCacheRead / prevPool) * 100 : 0;
  const cacheTrend = prevPool > 0 ? recentCacheRate - prevCacheRate : 0;

  const totalProjectCost = projectStats.reduce((s, p) => s + (p.totalCost ?? 0), 0);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Dashboard</h1>

      {/* Stats cards */}
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Total Tokens
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold font-mono">
              {formatTokens(user.totalTokens)}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Total Cost
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold font-mono">
              ${Number(user.totalCost).toFixed(2)}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Global Rank
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold font-mono">
              {globalRank ? `#${globalRank.rank}` : "--"}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Streak
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold font-mono">
              {user.currentStreak}d
            </span>
            {user.longestStreak > user.currentStreak && (
              <span className="ml-2 text-xs text-muted-foreground">
                best: {user.longestStreak}d
              </span>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Burn rate projection */}
      {recentCost > 0 && (
        <Card className="mb-8">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Projected Monthly Spend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-bold font-mono">
                ${projectedMonthly.toFixed(2)}
              </span>
              <span
                className={`text-sm font-mono ${trend > 0 ? "text-red-400" : trend < 0 ? "text-green-400" : "text-muted-foreground"}`}
              >
                {trend > 0 ? "+" : ""}
                {trend.toFixed(0)}% vs prev 7d
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Based on ${recentCost.toFixed(2)} spent in last 7 days
            </p>
          </CardContent>
        </Card>
      )}

      {/* Cache efficiency */}
      {cachePool > 0 && (
        <Card className="mb-8">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Cache Efficiency
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-bold font-mono">
                {cacheHitRate.toFixed(1)}%
              </span>
              {prevPool > 0 && (
                <span
                  className={`text-sm font-mono ${cacheTrend > 0 ? "text-green-400" : cacheTrend < 0 ? "text-red-400" : "text-muted-foreground"}`}
                >
                  {cacheTrend > 0 ? "+" : ""}
                  {cacheTrend.toFixed(1)}pp vs prev 7d
                </span>
              )}
            </div>
            <div className="mt-3 h-2 rounded-full bg-muted">
              <div
                className="h-2 rounded-full bg-green-500"
                style={{ width: `${Math.min(cacheHitRate, 100)}%` }}
              />
            </div>
            <div className="mt-2 flex justify-between text-xs text-muted-foreground">
              <span>{formatTokens(totalCacheRead)} cache hits</span>
              <span>{formatTokens(totalInput)} uncached input</span>
            </div>
            {recentPool > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Last 7 days: {recentCacheRate.toFixed(1)}% hit rate
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Model efficiency */}
      {modelStats.length > 0 && (
        <Card className="mb-8">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Top Models by Cost
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {modelStats.slice(0, 5).map((m) => {
                const pct = totalModelCost > 0 ? ((m.totalCost ?? 0) / totalModelCost) * 100 : 0;
                return (
                  <div key={m.model}>
                    <div className="flex justify-between text-sm">
                      <span className="font-mono truncate mr-4">{m.model}</span>
                      <span className="font-mono text-muted-foreground shrink-0">
                        ${(m.totalCost ?? 0).toFixed(2)} ({pct.toFixed(0)}%)
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-muted">
                      <div
                        className="h-1.5 rounded-full bg-foreground"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {expensiveRatio > 60 && (
              <p className="mt-4 text-xs text-muted-foreground">
                {expensiveRatio.toFixed(0)}% of your spend goes to frontier models.
                Consider using lighter models for simple tasks.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Per-project cost breakdown */}
      {projectStats.length > 0 && (
        <Card className="mb-8">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Top Projects by Cost
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {projectStats.slice(0, 8).map((p) => {
                const pct = totalProjectCost > 0 ? ((p.totalCost ?? 0) / totalProjectCost) * 100 : 0;
                return (
                  <div key={p.project}>
                    <div className="flex justify-between text-sm">
                      <span className="font-mono truncate mr-4">{p.project}</span>
                      <span className="font-mono text-muted-foreground shrink-0">
                        ${(p.totalCost ?? 0).toFixed(2)} ({formatTokens(p.totalTokens ?? 0)})
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-muted">
                      <div
                        className="h-1.5 rounded-full bg-foreground"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Activity heatmap */}
      {activity.length > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Activity</CardTitle>
                {availableYears.length > 1 && (
                  <div className="flex gap-1">
                    <Link
                      href={`/dashboard${selectedClient ? `?client=${selectedClient}` : ""}`}
                      className={`rounded px-2 py-1 text-xs font-mono ${!selectedYear ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      Recent
                    </Link>
                    {availableYears.map((y) => (
                      <Link
                        key={y}
                        href={`/dashboard?year=${y}${selectedClient ? `&client=${selectedClient}` : ""}`}
                        className={`rounded px-2 py-1 text-xs font-mono ${selectedYear === y ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        {y}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
              {allClients.length > 1 && (
                <div className="flex flex-wrap gap-1">
                  <Link
                    href={`/dashboard${selectedYear ? `?year=${selectedYear}` : ""}`}
                    className={`rounded px-2 py-1 text-xs font-mono ${!selectedClient ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    All
                  </Link>
                  {allClients.map((c) => (
                    <Link
                      key={c}
                      href={`/dashboard?client=${c}${selectedYear ? `&year=${selectedYear}` : ""}`}
                      className={`rounded px-2 py-1 text-xs font-mono ${selectedClient === c ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      {c}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <ActivityHeatmap
              data={heatmapData.map((a) => ({ date: a.date, value: a.tokens }))}
              year={selectedYear}
              selectedDate={selectedDay}
              hrefBuilder={(date) => {
                const p = new URLSearchParams();
                if (selectedYear) p.set("year", String(selectedYear));
                if (selectedClient) p.set("client", selectedClient);
                p.set("day", date);
                return `/dashboard?${p}`;
              }}
            />
          </CardContent>
          {dayDetail && selectedDay && (
            <CardContent className="border-t pt-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-mono text-sm font-bold">{selectedDay}</span>
                <Link href={`/dashboard${selectedYear ? `?year=${selectedYear}` : ""}${selectedClient ? `${selectedYear ? "&" : "?"}client=${selectedClient}` : ""}`} className="text-xs text-muted-foreground hover:text-foreground">
                  Dismiss
                </Link>
              </div>
              {dayDetail.byClient.length > 0 && (
                <div className="mb-3">
                  <span className="text-xs text-muted-foreground">By Client</span>
                  <div className="mt-1 space-y-1">
                    {dayDetail.byClient.map((c) => (
                      <div key={c.client} className="flex justify-between text-sm">
                        <span className="font-mono">{c.client}</span>
                        <span className="font-mono text-muted-foreground">
                          {formatTokens(c.tokens)} / ${(c.cost ?? 0).toFixed(2)} / {c.sessions}s
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {dayDetail.byModel.length > 0 && (
                <div>
                  <span className="text-xs text-muted-foreground">By Model</span>
                  <div className="mt-1 space-y-1">
                    {dayDetail.byModel.map((m) => (
                      <div key={m.model} className="flex justify-between text-sm">
                        <span className="font-mono truncate mr-4">{m.model}</span>
                        <span className="font-mono text-muted-foreground shrink-0">
                          {formatTokens(m.tokens)} / ${(m.cost ?? 0).toFixed(2)} / {m.sessions}s
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {/* CLI setup */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="text-sm">Submit your usage</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            <Link href="/settings" className="underline">
              Generate an API token
            </Link>
            , then run:
          </p>
          <code className="block rounded bg-muted px-4 py-3 font-mono text-sm">
            bunx tokenmaxxing submit
          </code>
        </CardContent>
      </Card>

      {/* Recent activity */}
      <h2 className="mb-4 text-lg font-semibold">Recent Activity</h2>
      {activity.length === 0 ? (
        <p className="text-muted-foreground">
          No activity yet. Run the CLI to submit your first data.
        </p>
      ) : (
        <div className="space-y-2">
          {activity.slice(0, 30).map((a) => (
            <div
              key={a.date}
              className="flex items-center justify-between rounded border border-border px-4 py-3"
            >
              <span className="font-mono text-sm text-muted-foreground">
                {a.date}
              </span>
              <div className="flex items-center gap-4">
                <Badge variant="secondary" className="font-mono text-xs">
                  {formatTokens(a.tokens)} tokens
                </Badge>
                <Badge variant="secondary" className="font-mono text-xs">
                  ${Number(a.cost).toFixed(2)}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {a.sessions} sessions
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
