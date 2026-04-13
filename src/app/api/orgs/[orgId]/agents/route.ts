import { validateOrgAccess } from "@/lib/auth";
import { createAgent } from "@/lib/board/mutations";
import { listAgents } from "@/lib/board/data";
import { ZodError, z } from "zod";

const createAgentSchema = z.object({
  name: z.string().trim().min(1),
  shortname: z.string().trim().min(1),
  model: z.string().trim().min(1),
  provider: z.string().trim().min(1),
  role: z.string().trim().min(1),
  title: z.string().trim().min(1),
  systemPrompt: z.string().trim().optional(),
  monthlyBudgetCents: z.number().int().nonnegative().optional(),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);

  const status =
    new URL(request.url).searchParams.get("status") ?? undefined;

  return Response.json(await listAgents(orgId, { status }));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const session = await validateOrgAccess(orgId);

  try {
    const body = createAgentSchema.parse(await request.json());
    const agent = await createAgent({
      ...body,
      orgId,
      actorId: session.userId,
    });

    return Response.json(agent, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues }, { status: 400 });
    }

    throw error;
  }
}
