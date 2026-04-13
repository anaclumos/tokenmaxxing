import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z, ZodError } from "zod";

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  shortname: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  systemPrompt: z.string().nullable().optional(),
  reportsTo: z.string().uuid().nullable().optional(),
  heartbeatCron: z.string().nullable().optional(),
  monthlyBudgetCents: z.number().int().nonnegative().nullable().optional(),
  status: z.string().optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string; agentId: string }> },
) {
  const { orgId, agentId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));

  if (!agent) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(agent);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orgId: string; agentId: string }> },
) {
  const { orgId, agentId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  try {
    const body = updateAgentSchema.parse(await req.json());
    const [agent] = await db
      .update(agents)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)))
      .returning();

    if (!agent) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(agent);
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ orgId: string; agentId: string }> },
) {
  const { orgId, agentId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const [agent] = await db
    .update(agents)
    .set({ status: "archived", updatedAt: new Date() })
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)))
    .returning();

  if (!agent) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(agent);
}
