import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { plugins } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const rows = await db
    .select()
    .from(plugins)
    .where(eq(plugins.orgId, orgId))
    .orderBy(desc(plugins.installedAt));

  return Response.json(rows);
}
