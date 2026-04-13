import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { activityLog } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const url = new URL(req.url);
  const resourceType = url.searchParams.get("resourceType");
  const actorType = url.searchParams.get("actorType");

  const conditions = [eq(activityLog.orgId, orgId)];
  if (resourceType) conditions.push(eq(activityLog.resourceType, resourceType));
  if (actorType) conditions.push(eq(activityLog.actorType, actorType));

  const rows = await db
    .select()
    .from(activityLog)
    .where(and(...conditions))
    .orderBy(desc(activityLog.createdAt))
    .limit(100);

  return Response.json(rows);
}
