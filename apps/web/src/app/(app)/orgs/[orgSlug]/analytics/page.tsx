import { auth, clerkClient } from "@clerk/nextjs/server";
import { users, dailyAggregates, usageRecords } from "@tokenmaxxing/db/index";
import { formatTokens, sumAggregateTokens } from "@tokenmaxxing/shared/types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@tokenmaxxing/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tokenmaxxing/ui/components/table";
import { gte, and, inArray, sum, count, isNotNull, desc, sql } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { db } from "@/lib/db";
import { parseAnalyticsDayRange } from "@/lib/search-params";

import { FilterTabs } from "../../filter-tabs";

const DAYS_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "0", label: "All time" },
];

export default async function OrgAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const [{ orgSlug }, query] = await Promise.all([params, searchParams]);
  const { userId: clerkId, orgId, orgSlug: activeSlug } = await auth();
  if (!clerkId) redirect("/sign-in");
  if (!orgId || activeSlug !== orgSlug) notFound();

  const client = await clerkClient();
  const org = await client.organizations.getOrganization({
    organizationId: orgId,
  });

  const days = parseAnalyticsDayRange(query.days);
  const since =
    days > 0
      ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
      : null;

  // Get org members
  const members = await client.organizations.getOrganizationMembershipList({
    organizationId: orgId,
    limit: 500,
  });
  const clerkIds = members.data
    .map((m) => m.publicUserData?.userId)
    .filter((id): id is string => Boolean(id));

  if (clerkIds.length === 0) {
    return (
      <main className="mx-auto w-full max-w-4xl px-6 py-8">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">{org.name}</h1>
        <p className="text-muted-foreground">No members found.</p>
      </main>
    );
  }

  const dbUsers = await db()
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(users.clerkId, clerkIds));
  const userIds = dbUsers.map((u) => u.id);

  const rows =
    userIds.length > 0
      ? await db()
          .select({
            userId: dailyAggregates.userId,
            totalInput: dailyAggregates.totalInput,
            totalOutput: dailyAggregates.totalOutput,
            totalCacheRead: dailyAggregates.totalCacheRead,
            totalCacheWrite: dailyAggregates.totalCacheWrite,
            totalReasoning: dailyAggregates.totalReasoning,
            totalCost: dailyAggregates.totalCost,
            sessionCount: dailyAggregates.sessionCount,
          })
          .from(dailyAggregates)
          .where(
            since
              ? and(
                  inArray(dailyAggregates.userId, userIds),
                  gte(dailyAggregates.date, since)
                )
              : inArray(dailyAggregates.userId, userIds)
          )
      : [];

  // Per-project breakdown
  const projectRows =
    userIds.length > 0
      ? await db()
          .select({
            project: usageRecords.project,
            sessions: count(),
            totalCost: sum(usageRecords.costUsd).mapWith(Number),
            totalTokens: sql<number>`sum(${usageRecords.inputTokens} + ${usageRecords.outputTokens} + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens} + ${usageRecords.reasoningTokens})`.mapWith(Number),
          })
          .from(usageRecords)
          .where(
            since
              ? and(
                  inArray(usageRecords.userId, userIds),
                  isNotNull(usageRecords.project),
                  gte(usageRecords.timestamp, new Date(since))
                )
              : and(
                  inArray(usageRecords.userId, userIds),
                  isNotNull(usageRecords.project)
                )
          )
          .groupBy(usageRecords.project)
          .orderBy(desc(sum(usageRecords.costUsd)))
      : [];

  // Aggregate per member
  const userMap = new Map(dbUsers.map((u) => [u.id, u.username]));
  const byMember = new Map<
    string,
    { username: string; tokens: number; cost: number; sessions: number }
  >();
  let totalTokens = 0;
  let totalCost = 0;

  for (const r of rows) {
    const tokens = sumAggregateTokens(r);
    const cost = Number(r.totalCost);
    totalTokens += tokens;
    totalCost += cost;

    const username = userMap.get(r.userId) ?? "unknown";
    const m = byMember.get(r.userId) ?? {
      username,
      tokens: 0,
      cost: 0,
      sessions: 0,
    };
    m.tokens += tokens;
    m.cost += cost;
    m.sessions += r.sessionCount;
    byMember.set(r.userId, m);
  }

  const sortedMembers = [...byMember.values()].toSorted(
    (a, b) => b.cost - a.cost
  );

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">{org.name}</h1>
      <p className="mb-6 text-muted-foreground">Team analytics</p>

      <FilterTabs param="days" value={String(days)} options={DAYS_OPTIONS} />

      <div className="mb-8 grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Total Tokens
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold font-mono">
              {formatTokens(totalTokens)}
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
              ${totalCost.toFixed(2)}
            </span>
          </CardContent>
        </Card>
      </div>

      {projectRows.length > 0 && (
        <>
          <h2 className="mb-3 text-lg font-semibold">By Project</h2>
          <Table className="mb-8">
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projectRows.slice(0, 20).map((p) => (
                <TableRow key={p.project}>
                  <TableCell className="font-medium font-mono">{p.project}</TableCell>
                  <TableCell className="text-right font-mono">
                    {formatTokens(p.totalTokens ?? 0)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    ${(p.totalCost ?? 0).toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {p.sessions}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}

      <h2 className="mb-3 text-lg font-semibold">By Member</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Sessions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedMembers.map((m) => (
            <TableRow key={m.username}>
              <TableCell className="font-medium">{m.username}</TableCell>
              <TableCell className="text-right font-mono">
                {formatTokens(m.tokens)}
              </TableCell>
              <TableCell className="text-right font-mono">
                ${m.cost.toFixed(2)}
              </TableCell>
              <TableCell className="text-right text-muted-foreground">
                {m.sessions}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </main>
  );
}
