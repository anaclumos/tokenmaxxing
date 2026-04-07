import { clerkClient } from "@clerk/nextjs/server";
import { budgetAlertEvents, budgetAlerts, usageRecords, users } from "@tokenmaxxing/db/index";
import type { Db } from "@tokenmaxxing/db/index";
import { and, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { Resend } from "resend";

import { resendEnv } from "@/lib/env";

type BudgetAlertPeriod = "daily" | "weekly" | "monthly";

type CostRecord = {
  timestamp: Date;
  costUsd: number;
};

type BudgetAlertBucket = {
  key: string;
  startTime: Date;
  endTime: Date;
  cost: number;
};

type BudgetAlertRow = {
  id: string;
  orgId: string;
  userId: string | null;
  period: BudgetAlertPeriod;
  thresholdUsd: number;
  webhookUrl: string | null;
  emailNotify: boolean;
};

type TriggeredBudgetAlertEvent = {
  id: string;
  alertId: string;
  orgId: string;
  userId: string | null;
  period: BudgetAlertPeriod;
  thresholdUsd: number;
  actualCost: number;
  webhookUrl: string | null;
  emailNotify: boolean;
  triggeredAt: Date;
};

function getBudgetAlertBucket({
  date,
  period,
}: {
  date: Date;
  period: BudgetAlertPeriod;
}): BudgetAlertBucket {
  if (period === "daily") {
    const startTime = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const endTime = new Date(startTime);
    endTime.setUTCDate(endTime.getUTCDate() + 1);

    return {
      key: startTime.toISOString().slice(0, 10),
      startTime,
      endTime,
      cost: 0,
    };
  }

  if (period === "weekly") {
    const startTime = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const daysSinceMonday = (startTime.getUTCDay() + 6) % 7;
    startTime.setUTCDate(startTime.getUTCDate() - daysSinceMonday);

    const endTime = new Date(startTime);
    endTime.setUTCDate(endTime.getUTCDate() + 7);

    return {
      key: startTime.toISOString().slice(0, 10),
      startTime,
      endTime,
      cost: 0,
    };
  }

  const startTime = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const endTime = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));

  return {
    key: `${startTime.getUTCFullYear()}-${String(startTime.getUTCMonth() + 1).padStart(2, "0")}`,
    startTime,
    endTime,
    cost: 0,
  };
}

export function groupBudgetAlertBuckets({
  period,
  records,
}: {
  period: BudgetAlertPeriod;
  records: CostRecord[];
}) {
  const buckets = new Map<string, BudgetAlertBucket>();

  for (const record of records) {
    const bucket = getBudgetAlertBucket({
      date: record.timestamp,
      period,
    });
    const existing = buckets.get(bucket.key);

    if (existing) {
      existing.cost += record.costUsd;
      continue;
    }

    buckets.set(bucket.key, {
      ...bucket,
      cost: record.costUsd,
    });
  }

  return buckets;
}

function getBudgetAlertQueryWindow({ buckets }: { buckets: Map<string, BudgetAlertBucket> }) {
  const values = [...buckets.values()];
  if (values.length === 0) return null;

  return {
    startTime: values.reduce(
      (earliest, bucket) => (bucket.startTime < earliest ? bucket.startTime : earliest),
      values[0].startTime,
    ),
    endTime: values.reduce(
      (latest, bucket) => (bucket.endTime > latest ? bucket.endTime : latest),
      values[0].endTime,
    ),
  };
}

export function getTriggeredBudgetAlertEvents({
  alert,
  currentBuckets,
  insertedBuckets,
}: {
  alert: Pick<BudgetAlertRow, "id" | "orgId" | "period" | "thresholdUsd" | "userId">;
  currentBuckets: Map<string, BudgetAlertBucket>;
  insertedBuckets: Map<string, BudgetAlertBucket>;
}) {
  const events: Array<{
    alertId: string;
    actualCost: number;
    thresholdCost: number;
  }> = [];

  for (const [key, insertedBucket] of insertedBuckets) {
    const currentCost = currentBuckets.get(key)?.cost ?? 0;
    const previousCost = currentCost - insertedBucket.cost;

    if (previousCost < alert.thresholdUsd && currentCost >= alert.thresholdUsd) {
      events.push({
        alertId: alert.id,
        actualCost: currentCost,
        thresholdCost: alert.thresholdUsd,
      });
    }
  }

  return events;
}

async function getOrgMemberIdsByOrg({ database, orgIds }: { database: Db; orgIds: string[] }) {
  const client = await clerkClient();
  const memberships = await Promise.all(
    orgIds.map(async (orgId) => ({
      orgId,
      memberships: await client.organizations.getOrganizationMembershipList({
        organizationId: orgId,
        limit: 500,
      }),
    })),
  );

  const clerkIds = memberships.flatMap(({ memberships }) =>
    memberships.data
      .map((membership) => membership.publicUserData?.userId)
      .filter((id): id is string => Boolean(id)),
  );
  const localUsers =
    clerkIds.length > 0
      ? await database
          .select({
            id: users.id,
            clerkId: users.clerkId,
          })
          .from(users)
          .where(inArray(users.clerkId, clerkIds))
      : [];
  const userIdByClerkId = new Map(localUsers.map((user) => [user.clerkId, user.id]));

  return new Map(
    memberships.map(({ orgId, memberships }) => [
      orgId,
      memberships.data
        .map((membership) => membership.publicUserData?.userId)
        .filter((id): id is string => Boolean(id))
        .flatMap((clerkId) => {
          const localUserId = userIdByClerkId.get(clerkId);
          return localUserId ? [localUserId] : [];
        }),
    ]),
  );
}

async function getAlertRows({
  database,
  orgIds,
  userId,
}: {
  database: Db;
  orgIds: string[];
  userId: string;
}) {
  if (orgIds.length === 0) return [];

  const rows = await database
    .select({
      id: budgetAlerts.id,
      orgId: budgetAlerts.orgId,
      userId: budgetAlerts.userId,
      period: budgetAlerts.period,
      thresholdUsd: budgetAlerts.thresholdUsd,
      webhookUrl: budgetAlerts.webhookUrl,
      emailNotify: budgetAlerts.emailNotify,
    })
    .from(budgetAlerts)
    .where(
      and(
        inArray(budgetAlerts.orgId, orgIds),
        or(isNull(budgetAlerts.userId), eq(budgetAlerts.userId, userId)),
      ),
    );

  return rows.map((row) => ({
    ...row,
    thresholdUsd: Number(row.thresholdUsd),
  }));
}

async function getCurrentBuckets({
  database,
  period,
  recordsUserIds,
  window,
}: {
  database: Db;
  period: BudgetAlertPeriod;
  recordsUserIds: string[];
  window: { startTime: Date; endTime: Date } | null;
}) {
  if (recordsUserIds.length === 0 || !window) return new Map<string, BudgetAlertBucket>();

  const rows = await database
    .select({
      timestamp: usageRecords.timestamp,
      costUsd: usageRecords.costUsd,
    })
    .from(usageRecords)
    .where(
      and(
        inArray(usageRecords.userId, recordsUserIds),
        gte(usageRecords.timestamp, window.startTime),
        lt(usageRecords.timestamp, window.endTime),
      ),
    );

  return groupBudgetAlertBuckets({
    period,
    records: rows.map((row) => ({
      timestamp: row.timestamp,
      costUsd: Number(row.costUsd),
    })),
  });
}

function getBudgetAlertScopeLabel({
  orgName,
  username,
}: {
  orgName: string;
  username: string | null;
}) {
  return username ? username : `${orgName} team`;
}

function getBudgetAlertSubject({
  orgName,
  period,
  username,
}: {
  orgName: string;
  period: BudgetAlertPeriod;
  username: string | null;
}) {
  return `${getBudgetAlertScopeLabel({ orgName, username })} crossed a ${period} budget threshold`;
}

function getBudgetAlertHtml({
  dashboardUrl,
  orgName,
  period,
  actualCost,
  thresholdCost,
  username,
}: {
  dashboardUrl: string;
  orgName: string;
  period: BudgetAlertPeriod;
  actualCost: number;
  thresholdCost: number;
  username: string | null;
}) {
  return `<div style="font-family:system-ui,sans-serif;color:#111827">
  <p style="margin:0 0 12px;font-family:monospace;color:#2563eb">tokenmaxx.ing</p>
  <h1 style="margin:0 0 16px;font-size:24px">${getBudgetAlertScopeLabel({ orgName, username })} crossed a ${period} budget threshold</h1>
  <p style="margin:0 0 8px">Actual cost: <strong>$${actualCost.toFixed(2)}</strong></p>
  <p style="margin:0 0 20px">Threshold: <strong>$${thresholdCost.toFixed(2)}</strong></p>
  <p style="margin:0 0 20px">${username ? `${username} pushed usage above the configured ${period} limit.` : `Your organization crossed the configured ${period} limit.`}</p>
  <a href="${dashboardUrl}" style="display:inline-block;border-radius:999px;background:#2563eb;color:#fff;padding:10px 16px;text-decoration:none;font-weight:600">Open tokenmaxx.ing</a>
</div>`;
}

async function sendBudgetAlertWebhooks({
  events,
  orgById,
  userById,
}: {
  events: TriggeredBudgetAlertEvent[];
  orgById: Map<string, { name: string; slug: string | null }>;
  userById: Map<string, { username: string; email: string | null }>;
}) {
  await Promise.all(
    events
      .filter((event) => event.webhookUrl)
      .map(async (event) => {
        const org = orgById.get(event.orgId);
        const user = event.userId ? userById.get(event.userId) : null;
        const response = await fetch(event.webhookUrl!, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: "budget_alert_triggered",
            alertId: event.alertId,
            eventId: event.id,
            orgId: event.orgId,
            orgName: org?.name ?? event.orgId,
            userId: event.userId,
            username: user?.username ?? null,
            period: event.period,
            actualCost: event.actualCost,
            thresholdCost: event.thresholdUsd,
            triggeredAt: event.triggeredAt.toISOString(),
          }),
        });

        if (!response.ok) {
          throw new Error(`Webhook failed with status ${response.status}`);
        }
      }),
  );
}

async function sendBudgetAlertEmails({
  events,
  orgAdminEmailsByOrg,
  orgById,
  userById,
}: {
  events: TriggeredBudgetAlertEvent[];
  orgAdminEmailsByOrg: Map<string, string[]>;
  orgById: Map<string, { name: string; slug: string | null }>;
  userById: Map<string, { username: string; email: string | null }>;
}) {
  const emailEvents = events.filter((event) => event.emailNotify);
  if (emailEvents.length === 0) return;

  const resend = resendEnv();
  const client = new Resend(resend.RESEND_API_KEY);

  await Promise.all(
    emailEvents.map(async (event) => {
      const org = orgById.get(event.orgId);
      const user = event.userId ? userById.get(event.userId) : null;
      const recipients = getBudgetAlertEmailRecipients({
        event,
        orgAdminEmailsByOrg,
        userById,
      });

      if (recipients.length === 0) return;

      const { error } = await client.emails.send({
        from: resend.RESEND_FROM,
        to: recipients,
        subject: getBudgetAlertSubject({
          orgName: org?.name ?? event.orgId,
          period: event.period,
          username: user?.username ?? null,
        }),
        html: getBudgetAlertHtml({
          dashboardUrl: org?.slug
            ? `https://tokenmaxx.ing/app/orgs/${org.slug}/settings/budgets`
            : "https://tokenmaxx.ing/app",
          orgName: org?.name ?? event.orgId,
          period: event.period,
          actualCost: event.actualCost,
          thresholdCost: event.thresholdUsd,
          username: user?.username ?? null,
        }),
      });

      if (error) {
        throw new Error(error.message);
      }
    }),
  );
}

export function getBudgetAlertEmailRecipients({
  event,
  orgAdminEmailsByOrg,
  userById,
}: {
  event: Pick<TriggeredBudgetAlertEvent, "orgId" | "userId">;
  orgAdminEmailsByOrg: Map<string, string[]>;
  userById: Map<string, { username: string; email: string | null }>;
}) {
  const recipients = new Set(orgAdminEmailsByOrg.get(event.orgId) ?? []);
  if (event.userId) {
    const email = userById.get(event.userId)?.email;
    if (email) recipients.add(email);
  }
  return [...recipients];
}

export async function createBudgetAlertEvents({
  database,
  insertedRecords,
  userId,
}: {
  database: Db;
  insertedRecords: CostRecord[];
  userId: string;
}) {
  if (insertedRecords.length === 0) return [];

  const [user] = await database
    .select({ clerkId: users.clerkId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return [];

  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({
    userId: user.clerkId,
    limit: 500,
  });
  const orgIds = [...new Set(memberships.data.map((membership) => membership.organization.id))];
  const alerts = await getAlertRows({
    database,
    orgIds,
    userId,
  });
  if (alerts.length === 0) return [];

  const insertedBucketsByPeriod = new Map<BudgetAlertPeriod, Map<string, BudgetAlertBucket>>([
    [
      "daily",
      groupBudgetAlertBuckets({
        period: "daily",
        records: insertedRecords,
      }),
    ],
    [
      "weekly",
      groupBudgetAlertBuckets({
        period: "weekly",
        records: insertedRecords,
      }),
    ],
    [
      "monthly",
      groupBudgetAlertBuckets({
        period: "monthly",
        records: insertedRecords,
      }),
    ],
  ]);

  const orgWideOrgIds = [
    ...new Set(alerts.filter((alert) => alert.userId === null).map((alert) => alert.orgId)),
  ];
  const orgMemberIdsByOrg = await getOrgMemberIdsByOrg({
    database,
    orgIds: orgWideOrgIds,
  });

  const eventValues: Array<{
    alertId: string;
    actualCost: string;
    thresholdCost: string;
  }> = [];
  const triggeredEvents: Omit<TriggeredBudgetAlertEvent, "id" | "triggeredAt">[] = [];

  for (const alert of alerts) {
    const insertedBuckets = insertedBucketsByPeriod.get(alert.period);
    if (!insertedBuckets || insertedBuckets.size === 0) continue;

    const currentBuckets = await getCurrentBuckets({
      database,
      period: alert.period,
      recordsUserIds: alert.userId ? [userId] : (orgMemberIdsByOrg.get(alert.orgId) ?? []),
      window: getBudgetAlertQueryWindow({ buckets: insertedBuckets }),
    });

    const alertEvents = getTriggeredBudgetAlertEvents({
      alert,
      currentBuckets,
      insertedBuckets,
    });
    eventValues.push(
      ...alertEvents.map((event) => ({
        alertId: event.alertId,
        actualCost: event.actualCost.toFixed(6),
        thresholdCost: event.thresholdCost.toFixed(6),
      })),
    );
    triggeredEvents.push(
      ...alertEvents.map((event) => ({
        alertId: event.alertId,
        orgId: alert.orgId,
        userId: alert.userId,
        period: alert.period,
        thresholdUsd: alert.thresholdUsd,
        actualCost: event.actualCost,
        webhookUrl: alert.webhookUrl,
        emailNotify: alert.emailNotify,
      })),
    );
  }

  if (eventValues.length === 0) return [];

  const insertedEvents = await database.insert(budgetAlertEvents).values(eventValues).returning({
    id: budgetAlertEvents.id,
    alertId: budgetAlertEvents.alertId,
    actualCost: budgetAlertEvents.actualCost,
    thresholdCost: budgetAlertEvents.thresholdCost,
    triggeredAt: budgetAlertEvents.triggeredAt,
  });

  return insertedEvents.map((event) => {
    const match = triggeredEvents.find(
      (candidate) =>
        candidate.alertId === event.alertId &&
        candidate.actualCost === Number(event.actualCost) &&
        candidate.thresholdUsd === Number(event.thresholdCost),
    )!;

    return {
      ...match,
      id: event.id,
      triggeredAt: event.triggeredAt,
    };
  });
}

export async function sendBudgetAlertNotifications({
  database,
  events,
}: {
  database: Db;
  events: TriggeredBudgetAlertEvent[];
}) {
  if (events.length === 0) return;

  const orgIds = [...new Set(events.map((event) => event.orgId))];
  const userIds = [...new Set(events.flatMap((event) => (event.userId ? [event.userId] : [])))];
  const client = await clerkClient();
  const [orgs, localUsers] = await Promise.all([
    Promise.all(
      orgIds.map(async (orgId) => {
        const [org, memberships] = await Promise.all([
          client.organizations.getOrganization({ organizationId: orgId }),
          client.organizations.getOrganizationMembershipList({
            organizationId: orgId,
            limit: 500,
          }),
        ]);

        return { org, memberships };
      }),
    ),
    userIds.length > 0
      ? database
          .select({
            id: users.id,
            username: users.username,
            email: users.email,
          })
          .from(users)
          .where(inArray(users.id, userIds))
      : [],
  ]);

  const orgById = new Map(
    orgs.map(({ org }) => [org.id, { name: org.name, slug: org.slug ?? null }]),
  );
  const userById = new Map(localUsers.map((user) => [user.id, user]));

  const adminClerkIdsByOrg = new Map(
    orgs.map(({ org, memberships }) => [
      org.id,
      memberships.data
        .filter((membership) => membership.role === "org:admin")
        .flatMap((membership) => {
          const clerkId = membership.publicUserData?.userId;
          return clerkId ? [clerkId] : [];
        }),
    ]),
  );
  const uniqueAdminClerkIds = [
    ...new Set([...adminClerkIdsByOrg.values()].flatMap((clerkIds) => clerkIds)),
  ];
  const adminUsers =
    uniqueAdminClerkIds.length > 0
      ? await database
          .select({
            clerkId: users.clerkId,
            email: users.email,
          })
          .from(users)
          .where(inArray(users.clerkId, uniqueAdminClerkIds))
      : [];
  const adminEmailByClerkId = new Map(adminUsers.map((user) => [user.clerkId, user.email]));
  const orgAdminEmailsByOrg = new Map(
    [...adminClerkIdsByOrg.entries()].map(([orgId, clerkIds]) => [
      orgId,
      clerkIds.flatMap((clerkId) => {
        const email = adminEmailByClerkId.get(clerkId);
        return email ? [email] : [];
      }),
    ]),
  );

  await Promise.all([
    sendBudgetAlertWebhooks({
      events,
      orgById,
      userById,
    }),
    sendBudgetAlertEmails({
      events,
      orgAdminEmailsByOrg,
      orgById,
      userById,
    }),
  ]);
}
