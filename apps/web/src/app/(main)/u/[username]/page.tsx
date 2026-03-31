import { notFound } from "next/navigation";
import { eq, desc, and } from "drizzle-orm";
import { users, dailyAggregates, rankings } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";
import { formatTokens } from "@tokenmaxxing/shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@tokenmaxxing/ui/components/card";
import { Badge } from "@tokenmaxxing/ui/components/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@tokenmaxxing/ui/components/avatar";

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
      and(eq(rankings.leaderboardId, "global"), eq(rankings.userId, user.id), eq(rankings.period, "alltime")),
    )
    .limit(1);

  const activityRows = await db()
    .select({
      date: dailyAggregates.date,
      totalInput: dailyAggregates.totalInput,
      totalOutput: dailyAggregates.totalOutput,
      totalCacheRead: dailyAggregates.totalCacheRead,
      totalCacheWrite: dailyAggregates.totalCacheWrite,
      totalReasoning: dailyAggregates.totalReasoning,
      cost: dailyAggregates.totalCost,
    })
    .from(dailyAggregates)
    .where(eq(dailyAggregates.userId, user.id))
    .orderBy(desc(dailyAggregates.date));

  // Aggregate ALL-TIME totals for breakdown (matches user.totalTokens)
  const breakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const a of activityRows) {
    breakdown.input += a.totalInput;
    breakdown.output += a.totalOutput;
    breakdown.cacheRead += a.totalCacheRead;
    breakdown.cacheWrite += a.totalCacheWrite;
    breakdown.reasoning += a.totalReasoning;
  }
  const breakdownTotal = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite + breakdown.reasoning;

  const activity = activityRows.slice(0, 30).map((a) => ({
    date: a.date,
    tokens: a.totalInput + a.totalOutput + a.totalCacheRead + a.totalCacheWrite + a.totalReasoning,
    cost: a.cost,
  }));

  return (
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

      {/* Token breakdown */}
      {breakdownTotal > 0 && (
        <div className="mb-8">
          <h2 className="mb-4 text-lg font-semibold">Token Breakdown</h2>
          <div className="space-y-3">
            {([
              ["Input", breakdown.input],
              ["Output", breakdown.output],
              ["Cache Read", breakdown.cacheRead],
              ["Cache Write", breakdown.cacheWrite],
              ["Reasoning", breakdown.reasoning],
            ] as const).filter(([, v]) => v > 0).map(([label, value]) => (
              <div key={label}>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono">{formatTokens(value)} <span className="text-muted-foreground">({((value / breakdownTotal) * 100).toFixed(1)}%)</span></span>
                </div>
                <div className="h-2 rounded-full bg-muted">
                  <div className="h-2 rounded-full bg-foreground" style={{ width: `${(value / breakdownTotal) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
  );
}
