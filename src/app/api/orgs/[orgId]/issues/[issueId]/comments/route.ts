import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { issueComments } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { z, ZodError } from "zod";

const createCommentSchema = z.object({
  body: z.string().min(1),
  authorType: z.string().default("board"),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string; issueId: string }> },
) {
  const { orgId, issueId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const rows = await db
    .select()
    .from(issueComments)
    .where(
      and(eq(issueComments.orgId, orgId), eq(issueComments.issueId, issueId)),
    )
    .orderBy(asc(issueComments.createdAt));

  return Response.json(rows);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string; issueId: string }> },
) {
  const { orgId, issueId } = await params;
  const session = await validateOrgAccess(orgId);
  const db = getDb();

  try {
    const body = createCommentSchema.parse(await req.json());
    const [comment] = await db
      .insert(issueComments)
      .values({
        orgId,
        issueId,
        authorType: body.authorType,
        authorId: session.userId,
        body: body.body,
      })
      .returning();
    return Response.json(comment, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }
}
