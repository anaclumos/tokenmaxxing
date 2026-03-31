import { auth, clerkClient } from "@clerk/nextjs/server";
import { eq, gte, and, inArray, sum, count } from "drizzle-orm";
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
  if (clerkIds.length === 0) return Response.json({ members: [], models: [], clients: [], total: { tokens: 0, cost: 0 } });

  const dbUsers = await db().select({ id: users.id, username: users.username, clerkId: users.clerkId }).from(users).where(inArray(users.clerkId, clerkIds));
  const userIds = dbUsers.map((u) => u.id);
  if (userIds.length === 0) return Response.json({ members: [], models: [], clients: [], total: { tokens: 0, cost: 0 } });

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
      modelsUsed: dailyAggregates.modelsUsed,
      clientsUsed: dailyAggregates.clientsUsed,
    })
    .from(dailyAggregates)
    .where(and(inArray(dailyAggregates.userId, userIds), gte(dailyAggregates.date, since)));

  // Aggregate per member
  const userMap = new Map(dbUsers.map((u) => [u.id, u.username]));
  const byMember = new Map<string, { username: string; tokens: number; cost: number; sessions: number }>();
  const byModel = new Map<string, { tokens: number; cost: number }>();
  const byClient = new Map<string, { tokens: number; cost: number }>();
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

    for (const model of r.modelsUsed) {
      const v = byModel.get(model) ?? { tokens: 0, cost: 0 };
      v.tokens += tokens / r.modelsUsed.length; v.cost += cost / r.modelsUsed.length;
      byModel.set(model, v);
    }
    for (const cl of r.clientsUsed) {
      const v = byClient.get(cl) ?? { tokens: 0, cost: 0 };
      v.tokens += tokens / r.clientsUsed.length; v.cost += cost / r.clientsUsed.length;
      byClient.set(cl, v);
    }
  }

  return Response.json({
    total: { tokens: totalTokens, cost: totalCost },
    members: [...byMember.values()].sort((a, b) => b.cost - a.cost),
    models: [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 15).map(([name, v]) => ({ name, ...v })),
    clients: [...byClient.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([name, v]) => ({ name, ...v })),
    days,
  });
}
