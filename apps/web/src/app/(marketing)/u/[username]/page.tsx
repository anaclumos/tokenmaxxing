import { auth } from "@clerk/nextjs/server";
import { users, dailyAggregates, rankings } from "@tokenmaxxing/db/index";
import { summarizeDailyAggregateRows } from "@tokenmaxxing/shared/daily-aggregate-summary";
import { formatTokens, totalTokens, sumAggregateTokens } from "@tokenmaxxing/shared/types";
import { getEarnedBadges } from "@tokenmaxxing/shared/badges";
import {
  Bot,
  Calendar,
  CalendarDays,
  Crown,
  Flame,
  Medal,
  Rocket,
  Upload,
  Users,
  Zap,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@tokenmaxxing/ui/components/avatar";
import { Badge } from "@tokenmaxxing/ui/components/badge";
import { buttonVariants } from "@tokenmaxxing/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@tokenmaxxing/ui/components/card";
import { parseHeatmapTheme, parseHeatmapView } from "@tokenmaxxing/ui/components/heatmap";
import { cn } from "@tokenmaxxing/ui/lib/utils";
import { eq, desc, and } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActivityHeatmapPanel } from "@/components/app/activity-heatmap-panel";
import { db } from "@/lib/db";
import { queryClientActivity, queryDayBreakdown } from "@/lib/usage-queries";

import { ShareButton } from "./share-button";
import { getProfileUser } from "./profile-user";

const badgeToneClasses = {
  sky: {
    chip: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    icon: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  violet: {
    chip: "border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    icon: "border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  emerald: {
    chip: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    icon: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  amber: {
    chip: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    icon: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  rose: {
    chip: "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    icon: "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
} as const;

const badgeIcons = {
  upload: Upload,
  "calendar-days": CalendarDays,
  calendar: Calendar,
  flame: Flame,
  rocket: Rocket,
  users: Users,
  bot: Bot,
  zap: Zap,
  medal: Medal,
  crown: Crown,
} as const;

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const [{ userId: clerkId }, user] = await Promise.all([auth(), getProfileUser({ username })]);

  if (!user || (user.privacyMode && user.clerkId !== clerkId)) {
    return { title: "Profile - tokenmaxx.ing" };
  }

  return { title: `${user.username} - tokenmaxx.ing` };
}

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string }>;
  searchParams: Promise<{
    year?: string;
    client?: string;
    day?: string;
    theme?: string;
    view?: string;
  }>;
}) {
  const [{ username }, query] = await Promise.all([params, searchParams]);
  const { userId: clerkId } = await auth();

  const [user] = await db().select().from(users).where(eq(users.username, username)).limit(1);

  const isOwner = user?.clerkId === clerkId;
  if (!user || (user.privacyMode && !isOwner)) notFound();

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
        sessions: dailyAggregates.sessionCount,
        modelsUsed: dailyAggregates.modelsUsed,
        clientsUsed: dailyAggregates.clientsUsed,
      })
      .from(dailyAggregates)
      .where(eq(dailyAggregates.userId, user.id))
      .orderBy(desc(dailyAggregates.date)),
  ]);

  const summary = summarizeDailyAggregateRows({ rows: activityRows });
  const breakdown = summary.breakdown;
  const breakdownTotal = summary.totalTokens;
  const allModels = summary.models;
  const allClients = summary.clients;
  const cachePool = summary.cachePool;
  const cacheHitRate = summary.cacheHitRate;
  const earnedBadges = getEarnedBadges({
    context: {
      totalTokens: user.totalTokens,
      longestStreak: user.longestStreak,
      clientCount: allClients.length,
      modelCount: allModels.length,
      cacheHitRate,
      activeDays: summary.activeDays,
    },
  });

  const enriched = activityRows.map((a) => ({
    date: a.date,
    value: sumAggregateTokens(a),
    cost: Number(a.cost),
    sessions: a.sessions,
  }));

  // Client filter
  const sortedClients = allClients;
  const selectedClient =
    query.client && allClients.includes(query.client) ? query.client : undefined;

  const clientActivity = selectedClient ? await queryClientActivity(user.id, selectedClient) : null;

  // Day detail breakdown
  const selectedDay = query.day && /^\d{4}-\d{2}-\d{2}$/.test(query.day) ? query.day : undefined;
  const dayDetail = selectedDay ? await queryDayBreakdown(user.id, selectedDay) : null;

  // Theme + View + Year selectors
  const selectedTheme = parseHeatmapTheme(query.theme);
  const selectedView = parseHeatmapView(query.view);
  const availableYears = [...new Set(activityRows.map((a) => Number(a.date.slice(0, 4))))].toSorted(
    (a, b) => b - a,
  );
  const selectedYear = availableYears.find((year) => year === Number(query.year));

  const baseHeatmap = clientActivity ? clientActivity : enriched;
  const heatmapData = selectedYear
    ? baseHeatmap.filter((entry) => entry.date.startsWith(String(selectedYear)))
    : baseHeatmap;

  const dismissParams = new URLSearchParams();
  if (selectedYear) dismissParams.set("year", String(selectedYear));
  if (selectedClient) dismissParams.set("client", selectedClient);
  if (selectedTheme !== "green") dismissParams.set("theme", selectedTheme);
  if (selectedView !== "flat") dismissParams.set("view", selectedView);
  const dismissQuery = dismissParams.toString();
  const dismissHref = dismissQuery ? `/u/${username}?${dismissQuery}` : `/u/${username}`;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 pt-20 pb-8">
      {/* Profile header */}
      <div className="mb-8 flex items-center gap-4">
        <Avatar className="h-16 w-16">
          {user.avatarUrl && <AvatarImage src={user.avatarUrl} />}
          <AvatarFallback className="text-xl">{user.username[0]}</AvatarFallback>
        </Avatar>
        <div>
          <h1 className="text-2xl font-bold">{user.username}</h1>
          {globalRank && (
            <Badge variant="secondary" className="mt-1 font-mono">
              Rank #{globalRank.rank}
            </Badge>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Link
            href={`/u/${user.username}/wrapped`}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Wrapped
          </Link>
          <ShareButton
            path={`/u/${user.username}`}
            text={`${user.username}'s tokenmaxx.ing stats: ${formatTokens(user.totalTokens)} tokens, $${Number(user.totalCost).toFixed(2)} spent`}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-bold font-mono">{formatTokens(user.totalTokens)}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-bold font-mono">
              ${Number(user.totalCost).toFixed(2)}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Streak</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-bold font-mono">{user.currentStreak}d</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Score</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-bold font-mono">
              {globalRank ? Number(globalRank.compositeScore).toFixed(0) : "--"}
            </span>
          </CardContent>
        </Card>
      </div>

      {earnedBadges.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 text-lg font-semibold">Achievements</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {earnedBadges.map((badge) => (
              <div
                key={badge.id}
                className="flex items-start gap-3 rounded-2xl border border-border bg-background px-4 py-3"
              >
                {(() => {
                  const Icon = badgeIcons[badge.icon];

                  return (
                    <div
                      className={cn(
                        "flex size-10 shrink-0 items-center justify-center rounded-2xl border",
                        badgeToneClasses[badge.tone].icon,
                      )}
                    >
                      <Icon className="size-4" strokeWidth={2} />
                    </div>
                  );
                })()}
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{badge.name}</p>
                    <span
                      className={cn(
                        "inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px]",
                        badgeToneClasses[badge.tone].chip,
                      )}
                    >
                      {badge.mark}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{badge.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
            <span className="text-2xl font-bold font-mono">{cacheHitRate.toFixed(1)}%</span>
            <span className="text-sm text-muted-foreground">of input tokens served from cache</span>
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
      {(allModels.length > 0 || allClients.length > 0) && (
        <div className="mb-8 grid grid-cols-2 gap-6">
          {allModels.length > 0 && (
            <div>
              <h2 className="mb-3 text-lg font-semibold">Models Used</h2>
              <div className="flex flex-wrap gap-2">
                {allModels.map((m) => (
                  <Badge key={m} variant="outline" className="font-mono text-xs">
                    {m}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {allClients.length > 0 && (
            <div>
              <h2 className="mb-3 text-lg font-semibold">Clients Used</h2>
              <div className="flex flex-wrap gap-2">
                {allClients.map((c) => (
                  <Badge key={c} variant="outline" className="font-mono text-xs">
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
          <div className="mb-4">
            <h2 className="text-lg font-semibold">Activity</h2>
          </div>
          <ActivityHeatmapPanel
            data={heatmapData}
            years={availableYears}
            selectedYear={selectedYear}
            clients={sortedClients}
            selectedClient={selectedClient}
            selectedDate={selectedDay}
            initialTheme={selectedTheme}
            initialView={selectedView}
          />
          {dayDetail && selectedDay && (
            <div className="mt-4 rounded border border-border p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-mono text-sm font-bold">{selectedDay}</span>
                <Link
                  href={dismissHref}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
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
              <span className="font-mono text-sm text-muted-foreground">{a.date}</span>
              <div className="flex items-center gap-4">
                <Badge variant="secondary" className="font-mono text-xs">
                  {formatTokens(a.value)} tokens
                </Badge>
                <Badge variant="secondary" className="font-mono text-xs">
                  ${a.cost.toFixed(2)}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
