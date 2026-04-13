import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  activityLog,
  agents,
  costEvents,
  heartbeatRuns,
  mcpCatalogEntries,
  orgMcpInstallations,
  providerKeys,
  routines,
} from "@/lib/db/schema";

export async function getDashboardData(orgId: string) {
  const db = getDb();

  const [agentCount, runCount, spend, recentActivity] = await Promise.all([
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.status, "active"))),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.orgId, orgId)),
    db
      .select({ total: sql<string>`COALESCE(SUM(estimated_cost), 0)` })
      .from(costEvents)
      .where(eq(costEvents.orgId, orgId)),
    db.query.activityLog.findMany({
      where: eq(activityLog.orgId, orgId),
      orderBy: [desc(activityLog.createdAt)],
      limit: 10,
    }),
  ]);

  return {
    activeAgents: Number(agentCount[0]?.count ?? 0),
    totalRuns: Number(runCount[0]?.count ?? 0),
    monthlySpend: Number(spend[0]?.total ?? 0),
    recentActivity,
  };
}

export async function listActivityEntries(
  orgId: string,
  filters?: {
    actorType?: string;
    resourceType?: string;
  },
) {
  const db = getDb();
  const conditions = [eq(activityLog.orgId, orgId)];

  if (filters?.actorType) {
    conditions.push(eq(activityLog.actorType, filters.actorType));
  }

  if (filters?.resourceType) {
    conditions.push(eq(activityLog.resourceType, filters.resourceType));
  }

  return db.query.activityLog.findMany({
    where: and(...conditions),
    orderBy: [desc(activityLog.createdAt)],
    limit: 100,
  });
}
export async function getCostsData(
  orgId: string,
  filters?: {
    agentId?: string;
    from?: string;
    to?: string;
  },
) {
  const db = getDb();
  const conditions = [eq(costEvents.orgId, orgId)];

  if (filters?.agentId) {
    conditions.push(eq(costEvents.agentId, filters.agentId));
  }

  if (filters?.from) {
    conditions.push(sql`${costEvents.createdAt} >= ${new Date(filters.from)}`);
  }

  if (filters?.to) {
    conditions.push(sql`${costEvents.createdAt} <= ${new Date(filters.to)}`);
  }

  const [events, summary] = await Promise.all([
    db.query.costEvents.findMany({
      where: and(...conditions),
      orderBy: [desc(costEvents.createdAt)],
      limit: 500,
    }),
    db
      .select({
        totalCost: sql<string>`COALESCE(SUM(estimated_cost), 0)`,
        totalInputTokens: sql<number>`COALESCE(SUM(input_tokens), 0)`,
        totalOutputTokens: sql<number>`COALESCE(SUM(output_tokens), 0)`,
      })
      .from(costEvents)
      .where(and(...conditions)),
  ]);

  return {
    events,
    summary: {
      totalCost: Number(summary[0]?.totalCost ?? 0),
      totalInputTokens: Number(summary[0]?.totalInputTokens ?? 0),
      totalOutputTokens: Number(summary[0]?.totalOutputTokens ?? 0),
    },
  };
}

export async function listAgents(
  orgId: string,
  filters?: {
    status?: string;
  },
) {
  const db = getDb();
  const conditions = [eq(agents.orgId, orgId)];

  if (filters?.status) {
    conditions.push(eq(agents.status, filters.status));
  }

  return db.query.agents.findMany({
    where: and(...conditions),
    orderBy: [asc(agents.createdAt)],
  });
}

export async function getAgent(orgId: string, agentId: string) {
  const db = getDb();

  return db.query.agents.findFirst({
    where: and(eq(agents.orgId, orgId), eq(agents.id, agentId)),
  });
}

export async function getAgentCostSummary(orgId: string, agentId: string) {
  const db = getDb();

  const [summary] = await db
    .select({
      totalCost: sql<string>`COALESCE(SUM(estimated_cost), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(input_tokens), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(output_tokens), 0)`,
    })
    .from(costEvents)
    .where(and(eq(costEvents.orgId, orgId), eq(costEvents.agentId, agentId)));

  return {
    totalCost: Number(summary?.totalCost ?? 0),
    totalInputTokens: Number(summary?.totalInputTokens ?? 0),
    totalOutputTokens: Number(summary?.totalOutputTokens ?? 0),
  };
}

export async function listAgentRecentCosts(orgId: string, agentId: string) {
  const db = getDb();

  return db.query.costEvents.findMany({
    where: and(eq(costEvents.orgId, orgId), eq(costEvents.agentId, agentId)),
    orderBy: [desc(costEvents.createdAt)],
    limit: 5,
  });
}

export async function listAgentRecentActivity(orgId: string, agentId: string) {
  const db = getDb();

  return db.query.activityLog.findMany({
    where: and(
      eq(activityLog.orgId, orgId),
      eq(activityLog.resourceType, "agent"),
      eq(activityLog.resourceId, agentId),
    ),
    orderBy: [desc(activityLog.createdAt)],
    limit: 5,
  });
}

export async function listAgentRoutines(orgId: string, agentId: string) {
  const db = getDb();

  const rows = await db.query.routines.findMany({
    where: and(eq(routines.orgId, orgId), eq(routines.agentId, agentId)),
    with: {
      triggers: {
        columns: {
          cronExpression: true,
        },
      },
    },
    orderBy: [desc(routines.createdAt)],
  });

  return rows.map((routine) => ({
    ...routine,
    schedule: routine.triggers[0]?.cronExpression ?? null,
  }));
}

export async function listRoutines(orgId: string) {
  const db = getDb();

  const rows = await db.query.routines.findMany({
    where: eq(routines.orgId, orgId),
    with: {
      agent: {
        columns: {
          id: true,
          name: true,
          title: true,
        },
      },
      triggers: {
        columns: {
          cronExpression: true,
        },
      },
    },
    orderBy: [desc(routines.createdAt)],
  });

  return rows.map((routine) => ({
    ...routine,
    schedule: routine.triggers[0]?.cronExpression ?? null,
  }));
}

export async function listProviderKeyStatus(orgId: string) {
  const db = getDb();

  const rows = await db.query.providerKeys.findMany({
    columns: {
      provider: true,
      validatedAt: true,
      createdAt: true,
    },
    where: eq(providerKeys.orgId, orgId),
    orderBy: [asc(providerKeys.provider)],
  });

  return rows.map((row) => ({
    ...row,
    maskedKey: "••••••••",
  }));
}

export async function listMcpCatalogEntries() {
  const db = getDb();

  return db.query.mcpCatalogEntries.findMany({
    orderBy: [asc(mcpCatalogEntries.name)],
  });
}

export async function listOrgMcpInstallations(orgId: string) {
  const db = getDb();

  return db.query.orgMcpInstallations.findMany({
    where: eq(orgMcpInstallations.orgId, orgId),
    with: {
      catalogEntry: {
        columns: {
          id: true,
          name: true,
          authType: true,
          docsUrl: true,
          serverUrl: true,
        },
      },
    },
    orderBy: [desc(orgMcpInstallations.activatedAt)],
  });
}
