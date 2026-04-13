import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { z, ZodError } from "zod";

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  repoUrl: z.string().url().optional(),
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
    .from(projects)
    .where(eq(projects.orgId, orgId))
    .orderBy(desc(projects.createdAt));

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
    const body = createProjectSchema.parse(await req.json());
    const [project] = await db
      .insert(projects)
      .values({ ...body, orgId })
      .returning();
    return Response.json(project, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }
}
