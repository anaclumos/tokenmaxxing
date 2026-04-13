import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agents, issues, approvals, costEvents, activityLog } from "@/lib/db/schema";
import { eq, and, sql, desc, notInArray } from "drizzle-orm";

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

  const [issueCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    );

  const [approvalCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")));

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
    openIssues: Number(issueCount.count),
    pendingApprovals: Number(approvalCount.count),
    monthlySpend: Number(spend.total),
    recentActivity,
  });
}
