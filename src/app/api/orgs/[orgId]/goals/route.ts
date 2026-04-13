import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { goals } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { z, ZodError } from "zod";

const createGoalSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  parentId: z.string().uuid().optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const rows = await db
    .select()
    .from(goals)
    .where(eq(goals.orgId, orgId))
    .orderBy(desc(goals.createdAt));

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
    const body = createGoalSchema.parse(await req.json());
    const [goal] = await db
      .insert(goals)
      .values({ ...body, orgId, status: "active" })
      .returning();
    return Response.json(goal, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }
}
