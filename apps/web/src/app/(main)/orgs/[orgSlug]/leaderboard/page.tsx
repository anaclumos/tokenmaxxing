import { auth, clerkClient } from "@clerk/nextjs/server";
import { rankings, users } from "@tokenmaxxing/db/index";
import { formatTokens } from "@tokenmaxxing/shared/types";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@tokenmaxxing/ui/components/avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tokenmaxxing/ui/components/table";
import { eq, asc, and } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { db } from "@/lib/db";

import { FilterTabs } from "../../filter-tabs";

const PERIODS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "alltime", label: "All Time" },
];

export default async function OrgLeaderboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const [{ orgSlug }, query] = await Promise.all([params, searchParams]);
  const { userId: clerkId, orgId, orgSlug: activeSlug } = await auth();
  if (!clerkId) redirect("/sign-in");
  if (!orgId || activeSlug !== orgSlug) notFound();

  const client = await clerkClient();
  const org = await client.organizations.getOrganization({
    organizationId: orgId,
  });

  const period = (["daily", "weekly", "monthly", "alltime"] as const).includes(
    query.period as "daily" | "weekly" | "monthly" | "alltime"
  )
    ? (query.period as "daily" | "weekly" | "monthly" | "alltime")
    : "alltime";

  const entries = await db()
    .select({
      rank: rankings.rank,
      username: users.username,
      avatarUrl: users.avatarUrl,
      totalTokens: rankings.totalTokens,
      totalCost: rankings.totalCost,
      compositeScore: rankings.compositeScore,
    })
    .from(rankings)
    .innerJoin(users, eq(rankings.userId, users.id))
    .where(and(eq(rankings.leaderboardId, orgId), eq(rankings.period, period)))
    .orderBy(asc(rankings.rank));

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">{org.name}</h1>
      <p className="mb-6 text-muted-foreground">Org leaderboard</p>

      <FilterTabs param="period" value={period} options={PERIODS} />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">#</TableHead>
            <TableHead>User</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Score</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e) => (
            <TableRow key={e.rank}>
              <TableCell className="font-mono text-muted-foreground">
                {e.rank}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Avatar className="h-6 w-6">
                    {e.avatarUrl && <AvatarImage src={e.avatarUrl} />}
                    <AvatarFallback className="text-xs">
                      {e.username[0]}
                    </AvatarFallback>
                  </Avatar>
                  <span className="font-medium">{e.username}</span>
                </div>
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatTokens(e.totalTokens)}
              </TableCell>
              <TableCell className="text-right font-mono">
                ${Number(e.totalCost).toFixed(2)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {Number(e.compositeScore).toFixed(0)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </main>
  );
}
