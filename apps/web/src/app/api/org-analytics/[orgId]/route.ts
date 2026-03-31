import { auth, clerkClient } from "@clerk/nextjs/server";
import { gte, and, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { users, dailyAggregates } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";
import { sumAggregateTokens } from "@tokenmaxxing/shared/types";

export async function GET(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId: clerkId } = await auth();
  if (!clerkId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Verify org exists
  const client = await clerkClient();
  try {
    await client.organizations.getOrganization({ organizationId: orgId });
  } catch {
    return Response.json({ error: "Organization not found" }, { status: 404 });
  }

  // Get org member DB IDs
  const members = await client.organizations.getOrganizationMembershipList({ organizationId: orgId, limit: 500 });
  const clerkIds = members.data.map((m) => m.publicUserData?.userId).filter((id): id is string => Boolean(id));
  if (clerkIds.length === 0) return Response.json({ members: [], total: { tokens: 0, cost: 0 } });

  const dbUsers = await db().select({ id: users.id, username: users.username, clerkId: users.clerkId }).from(users).where(inArray(users.clerkId, clerkIds));
  const userIds = dbUsers.map((u) => u.id);
  if (userIds.length === 0) return Response.json({ members: [], total: { tokens: 0, cost: 0 } });

  // Time filter
  const { searchParams } = new URL(req.url);
  const days = Math.min(365, Math.max(1, Number(searchParams.get("days") ?? 30)));
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  // Fetch all daily aggregates for org members in period
  const rows = await db()
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
    .where(and(inArray(dailyAggregates.userId, userIds), gte(dailyAggregates.date, since)));

  // Aggregate per member
  const userMap = new Map(dbUsers.map((u) => [u.id, u.username]));
  const byMember = new Map<string, { username: string; tokens: number; cost: number; sessions: number }>();
  let totalTokens = 0;
  let totalCost = 0;

  for (const r of rows) {
    const tokens = sumAggregateTokens(r);
    const cost = Number(r.totalCost);
    totalTokens += tokens;
    totalCost += cost;

    const username = userMap.get(r.userId) ?? "unknown";
    const m = byMember.get(r.userId) ?? { username, tokens: 0, cost: 0, sessions: 0 };
    m.tokens += tokens; m.cost += cost; m.sessions += r.sessionCount;
    byMember.set(r.userId, m);
  }

  return Response.json({
    total: { tokens: totalTokens, cost: totalCost },
    members: [...byMember.values()].sort((a, b) => b.cost - a.cost),
    days,
  });
}
