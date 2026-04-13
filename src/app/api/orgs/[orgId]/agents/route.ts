import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { z, ZodError } from "zod";

const createAgentSchema = z.object({
  name: z.string().min(1),
  shortname: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1),
  role: z.string().min(1),
  title: z.string().min(1),
  systemPrompt: z.string().optional(),
  reportsTo: z.string().uuid().optional(),
  heartbeatCron: z.string().optional(),
  monthlyBudgetCents: z.number().int().nonnegative().optional(),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const url = new URL(req.url);
  const status = url.searchParams.get("status");

  const conditions = [eq(agents.orgId, orgId)];
  if (status) conditions.push(eq(agents.status, status));

  const rows = await db
    .select()
    .from(agents)
    .where(and(...conditions))
    .orderBy(desc(agents.createdAt));

  return Response.json(rows);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  try {
    const body = createAgentSchema.parse(await req.json());
    const [agent] = await db
      .insert(agents)
      .values({ ...body, orgId })
      .returning();
    return Response.json(agent, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }
}
