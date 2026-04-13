import { validateOrgAccess } from "@/lib/auth";
import { listRoutines } from "@/lib/board/data";
import { createRoutine } from "@/lib/board/mutations";
import { ZodError, z } from "zod";

const createRoutineSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional(),
  agentId: z.string().uuid(),
  triggers: z
    .array(
      z.object({
        cronExpression: z.string().trim().min(1),
      }),
    )
    .optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);

  return Response.json(await listRoutines(orgId));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const session = await validateOrgAccess(orgId);

  try {
    const body = createRoutineSchema.parse(await request.json());
    const routine = await createRoutine({
      orgId,
      actorId: session.userId,
      name: body.name,
      description: body.description,
      agentId: body.agentId,
      cronExpression: body.triggers?.[0]?.cronExpression,
    });

    return Response.json(routine, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues }, { status: 400 });
    }

    if (error instanceof Error && error.message === "Agent not found") {
      return Response.json({ error: "Agent not found" }, { status: 400 });
    }

    throw error;
  }
}
