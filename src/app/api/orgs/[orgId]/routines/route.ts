import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { routines, routineTriggers } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { z, ZodError } from "zod";

const createRoutineSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  agentId: z.string().uuid(),
  triggers: z
    .array(
      z.object({
        cronExpression: z.string().min(1),
        variables: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const rows = await db
    .select()
    .from(routines)
    .where(eq(routines.orgId, orgId))
    .orderBy(desc(routines.createdAt));

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
    const body = createRoutineSchema.parse(await req.json());
    const { triggers, ...routineData } = body;

    const [routine] = await db
      .insert(routines)
      .values({ ...routineData, orgId })
      .returning();

    if (triggers?.length) {
      await db.insert(routineTriggers).values(
        triggers.map((t) => ({
          orgId,
          routineId: routine.id,
          cronExpression: t.cronExpression,
          variables: t.variables ?? null,
        })),
      );
    }

    return Response.json(routine, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }
}
