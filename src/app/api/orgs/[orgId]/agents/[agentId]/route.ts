import { validateOrgAccess } from "@/lib/auth";
import { getAgent } from "@/lib/board/data";
import { archiveAgent, updateAgent } from "@/lib/board/mutations";
import { ZodError, z } from "zod";

const updateAgentSchema = z.object({
  name: z.string().trim().min(1).optional(),
  shortname: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  systemPrompt: z.string().nullable().optional(),
  reportsTo: z.string().uuid().nullable().optional(),
  heartbeatCron: z.string().nullable().optional(),
  monthlyBudgetCents: z.number().int().nonnegative().nullable().optional(),
  status: z.string().trim().min(1).optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string; agentId: string }> },
) {
  const { orgId, agentId } = await params;
  await validateOrgAccess(orgId);

  const agent = await getAgent(orgId, agentId);
  if (!agent) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return Response.json(agent);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ orgId: string; agentId: string }> },
) {
  const { orgId, agentId } = await params;
  await validateOrgAccess(orgId);

  try {
    const body = updateAgentSchema.parse(await request.json());
    const agent = await updateAgent(orgId, agentId, body);

    if (!agent) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return Response.json(agent);
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues }, { status: 400 });
    }

    throw error;
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ orgId: string; agentId: string }> },
) {
  const { orgId, agentId } = await params;
  await validateOrgAccess(orgId);

  const agent = await archiveAgent(orgId, agentId);
  if (!agent) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return Response.json(agent);
}
