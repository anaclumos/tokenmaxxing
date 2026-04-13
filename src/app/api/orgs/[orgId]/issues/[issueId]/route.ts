import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { issues } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z, ZodError } from "zod";

const updateIssueSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string; issueId: string }> },
) {
  const { orgId, issueId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.orgId, orgId), eq(issues.id, issueId)));

  if (!issue) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(issue);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orgId: string; issueId: string }> },
) {
  const { orgId, issueId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  try {
    const body = updateIssueSchema.parse(await req.json());
    const [issue] = await db
      .update(issues)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(issues.orgId, orgId), eq(issues.id, issueId)))
      .returning();

    if (!issue) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(issue);
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }
}
