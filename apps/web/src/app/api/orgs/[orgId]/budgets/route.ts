import { auth, clerkClient } from "@clerk/nextjs/server";
import { budgetAlerts, users } from "@tokenmaxxing/db/index";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";

const Body = z.object({
  period: z.enum(["daily", "weekly", "monthly"]),
  thresholdUsd: z.number().positive(),
  userId: z.string().uuid().nullable().optional(),
  webhookUrl: z.url().optional(),
  emailNotify: z.boolean().default(false),
});

export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const [{ isAuthenticated, orgId, has }, { orgId: routeOrgId }] = await Promise.all([
    auth(),
    params,
  ]);

  if (!isAuthenticated || !orgId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (orgId !== routeOrgId || !has({ role: "org:admin" })) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: "Invalid body", details: parsed.error.issues }, { status: 400 });
  }

  const targetUserId = parsed.data.userId ?? null;

  if (targetUserId) {
    const client = await clerkClient();
    const members = await client.organizations.getOrganizationMembershipList({
      organizationId: routeOrgId,
      limit: 500,
    });
    const clerkIds = members.data
      .map((member) => member.publicUserData?.userId)
      .filter((id): id is string => Boolean(id));

    const [member] =
      clerkIds.length > 0
        ? await db()
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, targetUserId), inArray(users.clerkId, clerkIds)))
            .limit(1)
        : [];

    if (!member) {
      return Response.json({ error: "User is not in org" }, { status: 400 });
    }
  }

  if (targetUserId) {
    await db()
      .delete(budgetAlerts)
      .where(
        and(
          eq(budgetAlerts.orgId, routeOrgId),
          eq(budgetAlerts.period, parsed.data.period),
          eq(budgetAlerts.userId, targetUserId),
        ),
      );
  } else {
    await db()
      .delete(budgetAlerts)
      .where(
        and(
          eq(budgetAlerts.orgId, routeOrgId),
          eq(budgetAlerts.period, parsed.data.period),
          isNull(budgetAlerts.userId),
        ),
      );
  }

  const [alert] = await db()
    .insert(budgetAlerts)
    .values({
      orgId: routeOrgId,
      userId: targetUserId,
      period: parsed.data.period,
      thresholdUsd: parsed.data.thresholdUsd.toFixed(6),
      webhookUrl: parsed.data.webhookUrl ?? null,
      emailNotify: parsed.data.emailNotify,
      updatedAt: new Date(),
    })
    .returning({
      id: budgetAlerts.id,
      orgId: budgetAlerts.orgId,
      userId: budgetAlerts.userId,
      period: budgetAlerts.period,
      thresholdUsd: budgetAlerts.thresholdUsd,
      webhookUrl: budgetAlerts.webhookUrl,
      emailNotify: budgetAlerts.emailNotify,
    });

  return Response.json(
    {
      alert: {
        ...alert,
        thresholdUsd: Number(alert.thresholdUsd),
      },
    },
    { status: 201 },
  );
}
