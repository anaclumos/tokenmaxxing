import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { companySkills } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { z, ZodError } from "zod";

const createSkillSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  content: z.string().min(1),
  sourceType: z.enum(["manual", "github", "file"]).default("manual"),
  sourceUrl: z.string().url().optional(),
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
    .from(companySkills)
    .where(eq(companySkills.orgId, orgId))
    .orderBy(desc(companySkills.createdAt));

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
    const body = createSkillSchema.parse(await req.json());
    const [skill] = await db
      .insert(companySkills)
      .values({ ...body, orgId })
      .returning();
    return Response.json(skill, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    throw e;
  }
}
