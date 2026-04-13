import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { issues } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { z, ZodError } from "zod";

const createIssueSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  assigneeId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  goalId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
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
  const assignee = url.searchParams.get("assigneeId");
  const projectId = url.searchParams.get("projectId");

  const conditions = [eq(issues.orgId, orgId)];
  if (status) conditions.push(eq(issues.status, status));
  if (assignee) conditions.push(eq(issues.assigneeId, assignee));
  if (projectId) conditions.push(eq(issues.projectId, projectId));

  const rows = await db
    .select()
    .from(issues)
    .where(and(...conditions))
    .orderBy(desc(issues.createdAt));

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
    const body = createIssueSchema.parse(await req.json());
    const [issue] = await db
      .insert(issues)
      .values({ ...body, orgId })
      .returning();
    return Response.json(issue, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }
}
