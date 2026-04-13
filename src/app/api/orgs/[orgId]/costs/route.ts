import { validateOrgAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { costEvents } from "@/lib/db/schema";
import { eq, and, desc, gte, lte, sql } from "drizzle-orm";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  await validateOrgAccess(orgId);
  const db = getDb();

  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const conditions = [eq(costEvents.orgId, orgId)];
  if (agentId) conditions.push(eq(costEvents.agentId, agentId));
  if (from) conditions.push(gte(costEvents.createdAt, new Date(from)));
  if (to) conditions.push(lte(costEvents.createdAt, new Date(to)));

  const rows = await db
    .select()
    .from(costEvents)
    .where(and(...conditions))
    .orderBy(desc(costEvents.createdAt))
    .limit(500);

  const summary = await db
    .select({
      totalCost: sql<string>`COALESCE(SUM(estimated_cost), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(input_tokens), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(output_tokens), 0)`,
    })
    .from(costEvents)
    .where(and(...conditions));

  return Response.json({ events: rows, summary: summary[0] });
}
