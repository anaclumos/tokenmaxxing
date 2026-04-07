import { budgetAlerts } from "@tokenmaxxing/db/index";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";

import { getOrgAdminContext } from "../context";

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ orgId: string; budgetId: string }> },
) {
  const { orgId: routeOrgId, budgetId } = await params;
  const context = await getOrgAdminContext({ routeOrgId });
  if (context.error) return context.error;

  const [deleted] = await db()
    .delete(budgetAlerts)
    .where(and(eq(budgetAlerts.id, budgetId), eq(budgetAlerts.orgId, context.routeOrgId)))
    .returning({ id: budgetAlerts.id });

  if (!deleted) {
    return Response.json({ error: "Budget threshold not found" }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
