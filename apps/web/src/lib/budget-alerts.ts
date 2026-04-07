import { clerkClient } from "@clerk/nextjs/server";
import { budgetAlertEvents, budgetAlerts, usageRecords, users } from "@tokenmaxxing/db/index";
import type { Db } from "@tokenmaxxing/db/index";
import { and, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";

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
  alert: BudgetAlertRow;
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
    orgIds.map(async (orgId) => {
      return {
        orgId,
        memberships: await client.organizations.getOrganizationMembershipList({
          organizationId: orgId,
          limit: 500,
        }),
      };
    }),
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

export async function createBudgetAlertEvents({
  database,
  insertedRecords,
  userId,
}: {
  database: Db;
  insertedRecords: CostRecord[];
  userId: string;
}) {
  if (insertedRecords.length === 0) return;

  const [user] = await database
    .select({ clerkId: users.clerkId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return;

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
  if (alerts.length === 0) return;

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

  const eventValues = [];

  for (const alert of alerts) {
    const insertedBuckets = insertedBucketsByPeriod.get(alert.period);
    if (!insertedBuckets || insertedBuckets.size === 0) continue;

    const currentBuckets = await getCurrentBuckets({
      database,
      period: alert.period,
      recordsUserIds: alert.userId ? [userId] : (orgMemberIdsByOrg.get(alert.orgId) ?? []),
      window: getBudgetAlertQueryWindow({ buckets: insertedBuckets }),
    });

    eventValues.push(
      ...getTriggeredBudgetAlertEvents({
        alert,
        currentBuckets,
        insertedBuckets,
      }).map((event) => ({
        alertId: event.alertId,
        actualCost: event.actualCost.toFixed(6),
        thresholdCost: event.thresholdCost.toFixed(6),
      })),
    );
  }

  if (eventValues.length > 0) {
    await database.insert(budgetAlertEvents).values(eventValues);
  }
}
