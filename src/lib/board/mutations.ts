import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  agents,
  orgMcpInstallations,
  routineTriggers,
  routines,
} from "@/lib/db/schema";
import { logActivity } from "@/lib/services/activity";

type CreateAgentInput = {
  orgId: string;
  actorId: string;
  name: string;
  shortname: string;
  provider: string;
  model: string;
  role: string;
  title: string;
  systemPrompt?: string;
  monthlyBudgetCents?: number;
};

type UpdateAgentInput = Partial<{
  name: string;
  shortname: string;
  provider: string;
  model: string;
  role: string;
  title: string;
  systemPrompt: string | null;
  reportsTo: string | null;
  heartbeatCron: string | null;
  monthlyBudgetCents: number | null;
  status: string;
}>;

type CreateRoutineInput = {
  orgId: string;
  actorId: string;
  name: string;
  agentId: string;
  description?: string;
  cronExpression?: string;
};

type InstallMcpInput = {
  orgId: string;
  actorId: string;
  catalogEntryId?: string;
  customUrl?: string;
  customName?: string;
};

export async function createAgent(input: CreateAgentInput) {
  const db = getDb();

  const [agent] = await db
    .insert(agents)
    .values({
      orgId: input.orgId,
      name: input.name,
      shortname: input.shortname,
      provider: input.provider,
      model: input.model,
      role: input.role,
      title: input.title,
      systemPrompt: input.systemPrompt,
      monthlyBudgetCents: input.monthlyBudgetCents,
    })
    .returning();

  await logActivity({
    orgId: input.orgId,
    actorType: "board",
    actorId: input.actorId,
    action: "agent.created",
    resourceType: "agent",
    resourceId: agent.id,
    metadata: { name: agent.name },
  });

  return agent;
}

export async function updateAgent(
  orgId: string,
  agentId: string,
  values: UpdateAgentInput,
) {
  const db = getDb();

  const [agent] = await db
    .update(agents)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)))
    .returning();

  return agent ?? null;
}

export async function archiveAgent(orgId: string, agentId: string) {
  return updateAgent(orgId, agentId, { status: "archived" });
}

export async function createRoutine(input: CreateRoutineInput) {
  const db = getDb();
  const agent = await db.query.agents.findFirst({
    columns: { id: true },
    where: and(eq(agents.orgId, input.orgId), eq(agents.id, input.agentId)),
  });

  if (!agent) {
    throw new Error("Agent not found");
  }

  const [routine] = await db
    .insert(routines)
    .values({
      orgId: input.orgId,
      name: input.name,
      description: input.description,
      agentId: input.agentId,
    })
    .returning();

  if (input.cronExpression) {
    await db.insert(routineTriggers).values({
      orgId: input.orgId,
      routineId: routine.id,
      cronExpression: input.cronExpression,
      variables: null,
    });
  }

  await logActivity({
    orgId: input.orgId,
    actorType: "board",
    actorId: input.actorId,
    action: "routine.created",
    resourceType: "routine",
    resourceId: routine.id,
    metadata: { name: routine.name },
  });

  return routine;
}

export async function installMcpServer(input: InstallMcpInput) {
  const db = getDb();

  const [installation] = await db
    .insert(orgMcpInstallations)
    .values({
      orgId: input.orgId,
      catalogEntryId: input.catalogEntryId ?? null,
      customUrl: input.customUrl ?? null,
      customName: input.customName ?? null,
      status: "active",
      activatedBy: input.actorId,
      activatedAt: new Date(),
    })
    .returning();

  return installation;
}
