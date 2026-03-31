import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { eq, desc, and } from "drizzle-orm";
import { users, dailyAggregates, rankings } from "@tokenmaxxing/db/index";
import { db, totalTokensSql } from "@/lib/db";
import { formatTokens } from "@tokenmaxxing/shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@tokenmaxxing/ui/components/card";
import { Badge } from "@tokenmaxxing/ui/components/badge";
import { ActivityHeatmap } from "@tokenmaxxing/ui/components/heatmap";

export const metadata = { title: "Dashboard - tokenmaxx.ing" };

export default async function DashboardPage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/sign-in");

  const [user] = await db()
    .select()
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (!user) redirect("/sign-in");

  const [globalRank] = await db()
    .select({ rank: rankings.rank })
    .from(rankings)
    .where(
      and(eq(rankings.leaderboardId, "global"), eq(rankings.userId, user.id), eq(rankings.period, "alltime")),
    )
    .limit(1);

  const activity = await db()
    .select({
      date: dailyAggregates.date,
      tokens: totalTokensSql.as("tokens"),
      cost: dailyAggregates.totalCost,
      sessions: dailyAggregates.sessionCount,
    })
    .from(dailyAggregates)
    .where(eq(dailyAggregates.userId, user.id))
    .orderBy(desc(dailyAggregates.date))
    .limit(365);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Dashboard</h1>

      {/* Stats cards */}
      <div className="mb-8 grid grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Total Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold font-mono">{formatTokens(user.totalTokens)}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Total Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold font-mono">${Number(user.totalCost).toFixed(2)}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Global Rank</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold font-mono">
              {globalRank ? `#${globalRank.rank}` : "--"}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Streak</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold font-mono">{user.currentStreak}d</span>
            {user.longestStreak > user.currentStreak && (
              <span className="ml-2 text-xs text-muted-foreground">best: {user.longestStreak}d</span>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Activity heatmap */}
      {activity.length > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="text-sm">Activity</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <ActivityHeatmap data={activity.map((a) => ({ date: a.date, value: a.tokens }))} />
          </CardContent>
        </Card>
      )}

      {/* CLI setup */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="text-sm">Submit your usage</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            <Link href="/settings" className="underline">Generate an API token</Link>, then run:
          </p>
          <code className="block rounded bg-muted px-4 py-3 font-mono text-sm">
            bunx tokenmaxxing submit
          </code>
        </CardContent>
      </Card>

      {/* Recent activity */}
      <h2 className="mb-4 text-lg font-semibold">Recent Activity</h2>
      {activity.length === 0 ? (
        <p className="text-muted-foreground">No activity yet. Run the CLI to submit your first data.</p>
      ) : (
        <div className="space-y-2">
          {activity.map((a) => (
            <div key={a.date} className="flex items-center justify-between rounded border border-border px-4 py-3">
              <span className="font-mono text-sm text-muted-foreground">{a.date}</span>
              <div className="flex items-center gap-4">
                <Badge variant="secondary" className="font-mono text-xs">
                  {formatTokens(a.tokens)} tokens
                </Badge>
                <Badge variant="secondary" className="font-mono text-xs">
                  ${Number(a.cost).toFixed(2)}
                </Badge>
                <span className="text-xs text-muted-foreground">{a.sessions} sessions</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
