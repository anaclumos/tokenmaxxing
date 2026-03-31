import { notFound } from "next/navigation";
import Link from "next/link";
import { eq, desc, sql } from "drizzle-orm";
import { users, dailyAggregates, rankings } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@tokenmaxxing/ui/components/card";
import { Badge } from "@tokenmaxxing/ui/components/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@tokenmaxxing/ui/components/avatar";
import { Button } from "@tokenmaxxing/ui/components/button";

function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return { title: `${username} - tokenmaxx.ing` };
}

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;

  const [user] = await db()
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user || user.privacyMode) notFound();

  const [globalRank] = await db()
    .select({ rank: rankings.rank, compositeScore: rankings.compositeScore })
    .from(rankings)
    .where(
      sql`${rankings.leaderboardId} = 'global' AND ${rankings.userId} = ${user.id} AND ${rankings.period} = 'alltime'`,
    )
    .limit(1);

  const activity = await db()
    .select({
      date: dailyAggregates.date,
      tokens: sql<number>`${dailyAggregates.totalInput} + ${dailyAggregates.totalOutput} + ${dailyAggregates.totalCacheRead} + ${dailyAggregates.totalCacheWrite} + ${dailyAggregates.totalReasoning}`.as("tokens"),
      cost: dailyAggregates.totalCost,
    })
    .from(dailyAggregates)
    .where(eq(dailyAggregates.userId, user.id))
    .orderBy(desc(dailyAggregates.date))
    .limit(30);

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <Link href="/" className="text-lg font-semibold font-mono tracking-tight">tokenmaxx.ing</Link>
        <Link href="/leaderboard"><Button variant="ghost" size="sm">Leaderboard</Button></Link>
      </header>

      <main className="mx-auto w-full max-w-3xl px-6 py-8">
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
        </div>

        {/* Stats */}
        <div className="mb-8 grid grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Tokens</CardTitle></CardHeader>
            <CardContent><span className="text-xl font-bold font-mono">{formatTokens(user.totalTokens)}</span></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Cost</CardTitle></CardHeader>
            <CardContent><span className="text-xl font-bold font-mono">${Number(user.totalCost).toFixed(2)}</span></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Streak</CardTitle></CardHeader>
            <CardContent><span className="text-xl font-bold font-mono">{user.currentStreak}d</span></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Score</CardTitle></CardHeader>
            <CardContent><span className="text-xl font-bold font-mono">{globalRank ? Number(globalRank.compositeScore).toFixed(0) : "--"}</span></CardContent>
          </Card>
        </div>

        {/* Recent activity */}
        <h2 className="mb-4 text-lg font-semibold">Recent Activity</h2>
        {activity.length === 0 ? (
          <p className="text-muted-foreground">No activity yet.</p>
        ) : (
          <div className="space-y-2">
            {activity.map((a) => (
              <div key={a.date} className="flex items-center justify-between rounded border border-border px-4 py-3">
                <span className="font-mono text-sm text-muted-foreground">{a.date}</span>
                <div className="flex items-center gap-4">
                  <Badge variant="secondary" className="font-mono text-xs">{formatTokens(a.tokens)} tokens</Badge>
                  <Badge variant="secondary" className="font-mono text-xs">${Number(a.cost).toFixed(2)}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
