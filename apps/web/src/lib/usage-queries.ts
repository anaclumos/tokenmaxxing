import { usageRecords } from "@tokenmaxxing/db/index";
import { eq, and, gte, desc, sum, count, sql } from "drizzle-orm";

import { db } from "@/lib/db";

const TOKEN_SUM = sql<number>`sum(${usageRecords.inputTokens} + ${usageRecords.outputTokens} + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens} + ${usageRecords.reasoningTokens})`;

export type BreakdownRow = { tokens: number; cost: number; sessions: number };

export async function queryClientActivity(userId: string, client: string) {
  return db()
    .select({
      date: sql<string>`${usageRecords.timestamp}::date`,
      tokens: TOKEN_SUM.mapWith(Number),
    })
    .from(usageRecords)
    .where(and(eq(usageRecords.userId, userId), eq(usageRecords.client, client)))
    .groupBy(sql`${usageRecords.timestamp}::date`);
}

export async function queryDayBreakdown(userId: string, day: string) {
  const dayStart = new Date(day);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const where = and(eq(usageRecords.userId, userId), gte(usageRecords.timestamp, dayStart), sql`${usageRecords.timestamp} < ${dayEnd}`);

  const [byClient, byModel] = await Promise.all([
    db()
      .select({
        client: usageRecords.client,
        tokens: TOKEN_SUM.mapWith(Number),
        cost: sum(usageRecords.costUsd).mapWith(Number),
        sessions: count(),
      })
      .from(usageRecords)
      .where(where)
      .groupBy(usageRecords.client)
      .orderBy(desc(sum(usageRecords.costUsd))),
    db()
      .select({
        model: usageRecords.model,
        tokens: TOKEN_SUM.mapWith(Number),
        cost: sum(usageRecords.costUsd).mapWith(Number),
        sessions: count(),
      })
      .from(usageRecords)
      .where(where)
      .groupBy(usageRecords.model)
      .orderBy(desc(sum(usageRecords.costUsd))),
  ]);

  return { byClient, byModel };
}
