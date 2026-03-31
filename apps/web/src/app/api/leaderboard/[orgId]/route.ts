import { auth, clerkClient } from "@clerk/nextjs/server";
import { eq, asc, sql, and } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { rankings, users } from "@tokenmaxxing/db/index";
import { db } from "@/lib/db";

export async function GET(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { userId: clerkId, orgId: activeOrgId } = await auth();

  if (!clerkId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify user is a member of this org
  const client = await clerkClient();
  try {
    await client.organizations.getOrganization({ organizationId: orgId });
  } catch {
    return Response.json({ error: "Organization not found" }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const period = searchParams.get("period") ?? "alltime";
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 50)));
  const offset = (page - 1) * limit;

  const rows = await db()
    .select({
      rank: rankings.rank,
      username: users.username,
      avatarUrl: users.avatarUrl,
      totalTokens: rankings.totalTokens,
      totalCost: rankings.totalCost,
      compositeScore: rankings.compositeScore,
      streak: users.currentStreak,
    })
    .from(rankings)
    .innerJoin(users, eq(rankings.userId, users.id))
    .where(
      and(
        eq(rankings.leaderboardId, orgId),
        sql`${rankings.period} = ${period}`,
      ),
    )
    .orderBy(asc(rankings.rank))
    .limit(limit)
    .offset(offset);

  const [countRow] = await db()
    .select({ count: sql<number>`COUNT(*)`.as("count") })
    .from(rankings)
    .where(
      and(
        eq(rankings.leaderboardId, orgId),
        sql`${rankings.period} = ${period}`,
      ),
    );

  return Response.json({ entries: rows, total: countRow?.count ?? 0, page, period, orgId });
}
