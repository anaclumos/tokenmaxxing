import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { approvals } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const url = new URL(req.url);
  const status = url.searchParams.get("status");

  const conditions = [eq(approvals.orgId, orgId)];
  if (status) conditions.push(eq(approvals.status, status));

  const rows = await db
    .select()
    .from(approvals)
    .where(and(...conditions))
    .orderBy(desc(approvals.createdAt));

  return Response.json(rows);
}
