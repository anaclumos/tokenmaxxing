import { users, dailyAggregates, rankings } from "@tokenmaxxing/db/index";
import {
  formatTokens,
  totalTokens,
  sumAggregateTokens,
} from "@tokenmaxxing/shared/types";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@tokenmaxxing/ui/components/avatar";
import { Badge } from "@tokenmaxxing/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@tokenmaxxing/ui/components/card";
import { ActivityHeatmap, heatmapThemes, type HeatmapTheme } from "@tokenmaxxing/ui/components/heatmap";
import { eq, desc, and } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { db } from "@/lib/db";
import { queryClientActivity, queryDayBreakdown } from "@/lib/usage-queries";

import { ShareButton } from "./share-button";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  return { title: `${username} - tokenmaxx.ing` };
}

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string }>;
  searchParams: Promise<{ year?: string; client?: string; day?: string; theme?: string }>;
}) {
  const [{ username }, query] = await Promise.all([params, searchParams]);

  const [user] = await db()
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user || user.privacyMode) notFound();

  const [[globalRank], activityRows] = await Promise.all([
    db()
      .select({ rank: rankings.rank, compositeScore: rankings.compositeScore })
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
        modelsUsed: dailyAggregates.modelsUsed,
        clientsUsed: dailyAggregates.clientsUsed,
      })
      .from(dailyAggregates)
      .where(eq(dailyAggregates.userId, user.id))
      .orderBy(desc(dailyAggregates.date)),
  ]);

  // Aggregate ALL-TIME totals for breakdown (matches user.totalTokens)
  const breakdown = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
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
  const breakdownTotal = totalTokens(breakdown);

  // Cache efficiency
  const cachePool = breakdown.input + breakdown.cacheRead;
  const cacheHitRate = cachePool > 0 ? (breakdown.cacheRead / cachePool) * 100 : 0;

  const enriched = activityRows.map((a) => ({
    date: a.date,
    tokens: sumAggregateTokens(a),
    cost: a.cost,
  }));

  // Client filter
  const sortedClients = [...allClients].toSorted();
  const selectedClient = query.client && allClients.has(query.client) ? query.client : undefined;

  const clientActivity = selectedClient ? await queryClientActivity(user.id, selectedClient) : null;

  // Day detail breakdown
  const selectedDay = query.day && /^\d{4}-\d{2}-\d{2}$/.test(query.day) ? query.day : undefined;
  const dayDetail = selectedDay ? await queryDayBreakdown(user.id, selectedDay) : null;

  // Theme + Year selectors
  const selectedTheme: HeatmapTheme = query.theme && query.theme in heatmapThemes ? query.theme as HeatmapTheme : "green";
  const availableYears = [...new Set(activityRows.map((a) => Number(a.date.slice(0, 4))))].toSorted((a, b) => b - a);
  const selectedYear = query.year ? Number(query.year) : undefined;

  const baseHeatmap = clientActivity ?? enriched.map((a) => ({ date: a.date, tokens: a.tokens }));
  const heatmapData = selectedYear
    ? baseHeatmap.filter((a) => a.date.startsWith(String(selectedYear)))
    : baseHeatmap;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      {/* Profile header */}
      <div className="mb-8 flex items-center gap-4">
        <Avatar className="h-16 w-16">
          {user.avatarUrl && <AvatarImage src={user.avatarUrl} />}
          <AvatarFallback className="text-xl">
            {user.username[0]}
          </AvatarFallback>
        </Avatar>
        <div>
          <h1 className="text-2xl font-bold">{user.username}</h1>
          {globalRank && (
            <Badge variant="secondary" className="mt-1 font-mono">
              Rank #{globalRank.rank}
            </Badge>
          )}
        </div>
        <div className="ml-auto">
          <ShareButton
            username={user.username}
            tokens={formatTokens(user.totalTokens)}
            cost={Number(user.totalCost).toFixed(2)}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Tokens
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-bold font-mono">
              {formatTokens(user.totalTokens)}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Cost
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-bold font-mono">
              ${Number(user.totalCost).toFixed(2)}
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
            <span className="text-xl font-bold font-mono">
              {user.currentStreak}d
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Score
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-bold font-mono">
              {globalRank ? Number(globalRank.compositeScore).toFixed(0) : "--"}
            </span>
          </CardContent>
        </Card>
      </div>

      {/* Token breakdown */}
      {breakdownTotal > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 text-lg font-semibold">Token Breakdown</h2>
          <div className="space-y-3">
            {(
              [
                ["Input", breakdown.input],
                ["Output", breakdown.output],
                ["Cache Read", breakdown.cacheRead],
                ["Cache Write", breakdown.cacheWrite],
                ["Reasoning", breakdown.reasoning],
              ] as const
            )
              .filter(([, v]) => v > 0)
              .map(([label, value]) => (
                <div key={label}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-mono">
                      {formatTokens(value)}{" "}
                      <span className="text-muted-foreground">
                        ({((value / breakdownTotal) * 100).toFixed(1)}%)
                      </span>
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted">
                    <div
                      className="h-2 rounded-full bg-foreground"
                      style={{ width: `${(value / breakdownTotal) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Cache efficiency */}
      {cachePool > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 text-lg font-semibold">Cache Efficiency</h2>
          <div className="flex items-baseline gap-3 mb-3">
            <span className="text-2xl font-bold font-mono">
              {cacheHitRate.toFixed(1)}%
            </span>
            <span className="text-sm text-muted-foreground">
              of input tokens served from cache
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-green-500"
              style={{ width: `${Math.min(cacheHitRate, 100)}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{formatTokens(breakdown.cacheRead)} cache hits</span>
            <span>{formatTokens(breakdown.input)} uncached input</span>
          </div>
        </div>
      )}

      {/* Models & Clients */}
      {(allModels.size > 0 || allClients.size > 0) && (
        <div className="mb-8 grid grid-cols-2 gap-6">
          {allModels.size > 0 && (
            <div>
              <h2 className="mb-3 text-lg font-semibold">Models Used</h2>
              <div className="flex flex-wrap gap-2">
                {[...allModels].toSorted().map((m) => (
                  <Badge
                    key={m}
                    variant="outline"
                    className="font-mono text-xs"
                  >
                    {m}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {allClients.size > 0 && (
            <div>
              <h2 className="mb-3 text-lg font-semibold">Clients Used</h2>
              <div className="flex flex-wrap gap-2">
                {[...allClients].toSorted().map((c) => (
                  <Badge
                    key={c}
                    variant="outline"
                    className="font-mono text-xs"
                  >
                    {c}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Activity heatmap */}
      {enriched.length > 0 && (
        <div className="mb-8">
          <div className="mb-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Activity</h2>
              {availableYears.length > 1 && (
                <div className="flex gap-1">
                  <Link
                    href={`/u/${username}${selectedClient ? `?client=${selectedClient}` : ""}`}
                    className={`rounded px-2 py-1 text-xs font-mono ${!selectedYear ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    Recent
                  </Link>
                  {availableYears.map((y) => (
                    <Link
                      key={y}
                      href={`/u/${username}?year=${y}${selectedClient ? `&client=${selectedClient}` : ""}`}
                      className={`rounded px-2 py-1 text-xs font-mono ${selectedYear === y ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      {y}
                    </Link>
                  ))}
                </div>
              )}
            </div>
            {sortedClients.length > 1 && (
              <div className="flex flex-wrap gap-1">
                <Link
                  href={`/u/${username}${selectedYear ? `?year=${selectedYear}` : ""}${selectedTheme !== "green" ? `${selectedYear ? "&" : "?"}theme=${selectedTheme}` : ""}`}
                  className={`rounded px-2 py-1 text-xs font-mono ${!selectedClient ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  All
                </Link>
                {sortedClients.map((c) => (
                  <Link
                    key={c}
                    href={`/u/${username}?client=${c}${selectedYear ? `&year=${selectedYear}` : ""}${selectedTheme !== "green" ? `&theme=${selectedTheme}` : ""}`}
                    className={`rounded px-2 py-1 text-xs font-mono ${selectedClient === c ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {c}
                  </Link>
                ))}
              </div>
            )}
            <div className="flex gap-1">
              {(Object.entries(heatmapThemes) as [HeatmapTheme, { label: string }][]).map(([key, { label }]) => (
                <Link
                  key={key}
                  href={`/u/${username}?theme=${key}${selectedYear ? `&year=${selectedYear}` : ""}${selectedClient ? `&client=${selectedClient}` : ""}`}
                  className={`rounded px-2 py-1 text-xs font-mono ${selectedTheme === key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {label}
                </Link>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <ActivityHeatmap
              data={heatmapData.map((a) => ({ date: a.date, value: a.tokens }))}
              year={selectedYear}
              selectedDate={selectedDay}
              theme={selectedTheme}
              hrefBuilder={(date) => {
                const p = new URLSearchParams();
                if (selectedYear) p.set("year", String(selectedYear));
                if (selectedClient) p.set("client", selectedClient);
                if (selectedTheme !== "green") p.set("theme", selectedTheme);
                p.set("day", date);
                return `/u/${username}?${p}`;
              }}
            />
          </div>
          {dayDetail && selectedDay && (
            <div className="mt-4 rounded border border-border p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-mono text-sm font-bold">{selectedDay}</span>
                <Link href={`/u/${username}${selectedYear ? `?year=${selectedYear}` : ""}${selectedClient ? `${selectedYear ? "&" : "?"}client=${selectedClient}` : ""}`} className="text-xs text-muted-foreground hover:text-foreground">
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
            </div>
          )}
        </div>
      )}

      {/* Recent activity */}
      <h2 className="mb-4 text-lg font-semibold">Recent Activity</h2>
      {enriched.length === 0 ? (
        <p className="text-muted-foreground">No activity yet.</p>
      ) : (
        <div className="space-y-2">
          {enriched.slice(0, 30).map((a) => (
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
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
