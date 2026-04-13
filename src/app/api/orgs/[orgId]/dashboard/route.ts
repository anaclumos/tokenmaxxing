import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agents, costEvents, activityLog, heartbeatRuns } from "@/lib/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const [agentCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.status, "active")));

  const [runCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.orgId, orgId));

  const [spend] = await db
    .select({ total: sql<string>`COALESCE(SUM(estimated_cost), 0)` })
    .from(costEvents)
    .where(eq(costEvents.orgId, orgId));

  const recentActivity = await db
    .select()
    .from(activityLog)
    .where(eq(activityLog.orgId, orgId))
    .orderBy(desc(activityLog.createdAt))
    .limit(10);

  return Response.json({
    activeAgents: Number(agentCount.count),
    totalRuns: Number(runCount.count),
    monthlySpend: Number(spend.total),
    recentActivity,
  });
}
