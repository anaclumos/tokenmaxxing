import { budgetAlerts } from "@tokenmaxxing/db/index";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";

import { getOrgAdminContext } from "./context";

const Body = z.object({
  period: z.enum(["daily", "weekly", "monthly"]),
  thresholdUsd: z.number().positive(),
  userId: z.string().uuid().nullable().optional(),
  webhookUrl: z.url().optional(),
  emailNotify: z.boolean().default(false),
});

export async function GET(_: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId: routeOrgId } = await params;
  const context = await getOrgAdminContext({ routeOrgId });
  if (context.error) return context.error;

  const alerts = await db()
    .select({
      id: budgetAlerts.id,
      orgId: budgetAlerts.orgId,
      userId: budgetAlerts.userId,
      period: budgetAlerts.period,
      thresholdUsd: budgetAlerts.thresholdUsd,
      webhookUrl: budgetAlerts.webhookUrl,
      emailNotify: budgetAlerts.emailNotify,
      createdAt: budgetAlerts.createdAt,
      updatedAt: budgetAlerts.updatedAt,
    })
    .from(budgetAlerts)
    .where(eq(budgetAlerts.orgId, context.routeOrgId));

  const memberMap = new Map(context.members.map((member) => [member.id, member.username]));

  return Response.json({
    alerts: alerts.map((alert) => ({
      ...alert,
      thresholdUsd: Number(alert.thresholdUsd),
      username: alert.userId ? (memberMap.get(alert.userId) ?? null) : null,
    })),
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId: routeOrgId } = await params;
  const context = await getOrgAdminContext({ routeOrgId });
  if (context.error) return context.error;

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: "Invalid body", details: parsed.error.issues }, { status: 400 });
  }

  const targetUserId = parsed.data.userId ?? null;

  if (targetUserId) {
    const member = context.members.find((candidate) => candidate.id === targetUserId);

    if (!member) {
      return Response.json({ error: "User is not in org" }, { status: 400 });
    }
  }

  if (targetUserId) {
    await db()
      .delete(budgetAlerts)
      .where(
        and(
          eq(budgetAlerts.orgId, context.routeOrgId),
          eq(budgetAlerts.period, parsed.data.period),
          eq(budgetAlerts.userId, targetUserId),
        ),
      );
  } else {
    await db()
      .delete(budgetAlerts)
      .where(
        and(
          eq(budgetAlerts.orgId, context.routeOrgId),
          eq(budgetAlerts.period, parsed.data.period),
          isNull(budgetAlerts.userId),
        ),
      );
  }

  const [alert] = await db()
    .insert(budgetAlerts)
    .values({
      orgId: context.routeOrgId,
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
        username: targetUserId
          ? (context.members.find((member) => member.id === targetUserId)?.username ?? null)
          : null,
      },
    },
    { status: 201 },
  );
}
