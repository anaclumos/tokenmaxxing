import { dailyAggregates, usageRecords, users } from "@tokenmaxxing/db/index";
import { summarizeDailyAggregateRows } from "@tokenmaxxing/shared/daily-aggregate-summary";
import { and, count, desc, eq, gte, isNotNull, lt } from "drizzle-orm";
import { Resend } from "resend";

import { WeeklyDigestEmail } from "@/components/emails/weekly-digest-email";
import { db } from "@/lib/db";
import { cronEnv, weeklyDigestEnv } from "@/lib/env";
import {
  formatWeekOverWeekChange,
  getWeeklyDigestUnsubscribeUrl,
  getWeeklyDigestWindows,
} from "@/lib/weekly-digest";
import { TOKEN_SUM } from "@/lib/usage-queries";

const RESEND_BATCH_SIZE = 100;

async function buildWeeklyDigestMessage({
  currentWindow,
  origin,
  previousWindow,
  resendFrom,
  secret,
  user,
}: {
  currentWindow: ReturnType<typeof getWeeklyDigestWindows>["current"];
  origin: string;
  previousWindow: ReturnType<typeof getWeeklyDigestWindows>["previous"];
  resendFrom: string;
  secret: string;
  user: { id: string; username: string; email: string; currentStreak: number };
}) {
  const [aggregateRows, topModelRows, topClientRows] = await Promise.all([
    db()
      .select({
        date: dailyAggregates.date,
        totalInput: dailyAggregates.totalInput,
        totalOutput: dailyAggregates.totalOutput,
        totalCacheRead: dailyAggregates.totalCacheRead,
        totalCacheWrite: dailyAggregates.totalCacheWrite,
        totalReasoning: dailyAggregates.totalReasoning,
        totalCost: dailyAggregates.totalCost,
        sessionCount: dailyAggregates.sessionCount,
      })
      .from(dailyAggregates)
      .where(
        and(
          eq(dailyAggregates.userId, user.id),
          gte(dailyAggregates.date, previousWindow.startDate),
          lt(dailyAggregates.date, currentWindow.endDate),
        ),
      )
      .orderBy(desc(dailyAggregates.date)),
    db()
      .select({
        label: usageRecords.model,
        messages: count(),
      })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.userId, user.id),
          gte(usageRecords.timestamp, currentWindow.startTime),
          lt(usageRecords.timestamp, currentWindow.endTime),
        ),
      )
      .groupBy(usageRecords.model)
      .orderBy(desc(count()), desc(TOKEN_SUM))
      .limit(3),
    db()
      .select({
        label: usageRecords.client,
        messages: count(),
      })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.userId, user.id),
          gte(usageRecords.timestamp, currentWindow.startTime),
          lt(usageRecords.timestamp, currentWindow.endTime),
        ),
      )
      .groupBy(usageRecords.client)
      .orderBy(desc(count()), desc(TOKEN_SUM))
      .limit(3),
  ]);

  const currentRows = aggregateRows.filter((row) => row.date >= currentWindow.startDate);
  const previousRows = aggregateRows.filter((row) => row.date < currentWindow.startDate);

  if (currentRows.length === 0 && previousRows.length === 0) return null;

  const currentSummary = summarizeDailyAggregateRows({ rows: currentRows });
  const previousSummary = summarizeDailyAggregateRows({ rows: previousRows });

  let currentCost = 0;
  let previousCost = 0;
  let currentSessions = 0;
  let previousSessions = 0;

  for (const row of currentRows) {
    currentCost += Number(row.totalCost);
    currentSessions += row.sessionCount;
  }

  for (const row of previousRows) {
    previousCost += Number(row.totalCost);
    previousSessions += row.sessionCount;
  }

  return {
    from: resendFrom,
    to: [user.email],
    subject: `Your tokenmaxx.ing weekly digest for ${currentWindow.label}`,
    react: WeeklyDigestEmail({
      username: user.username,
      weekLabel: currentWindow.label,
      totalTokens: currentSummary.totalTokens,
      totalCost: currentCost,
      sessions: currentSessions,
      tokenChange: formatWeekOverWeekChange({
        current: currentSummary.totalTokens,
        previous: previousSummary.totalTokens,
      }),
      costChange: formatWeekOverWeekChange({
        current: currentCost,
        previous: previousCost,
      }),
      sessionChange: formatWeekOverWeekChange({
        current: currentSessions,
        previous: previousSessions,
      }),
      currentStreak: user.currentStreak,
      topModels: topModelRows.map((row) => row.label),
      topClients: topClientRows.map((row) => row.label),
      dashboardUrl: new URL("/app", origin).toString(),
      unsubscribeUrl: getWeeklyDigestUnsubscribeUrl({
        origin,
        secret,
        userId: user.id,
      }),
    }),
  };
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronEnv().CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const env = weeklyDigestEnv();
  const recipients = (
    await db()
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        currentStreak: users.currentStreak,
      })
      .from(users)
      .where(and(eq(users.weeklyDigestEnabled, true), isNotNull(users.email)))
  ).filter(
    (user): user is { id: string; username: string; email: string; currentStreak: number } => {
      return user.email !== null;
    },
  );

  const { current, previous } = getWeeklyDigestWindows({});
  const origin = new URL(req.url).origin;
  const resend = new Resend(env.RESEND_API_KEY);
  const messages = (
    await Promise.all(
      recipients.map((user) =>
        buildWeeklyDigestMessage({
          currentWindow: current,
          origin,
          previousWindow: previous,
          resendFrom: env.RESEND_FROM,
          secret: env.CRON_SECRET,
          user,
        }),
      ),
    )
  ).filter(
    (message): message is NonNullable<Awaited<ReturnType<typeof buildWeeklyDigestMessage>>> => {
      return message !== null;
    },
  );

  for (let index = 0; index < messages.length; index += RESEND_BATCH_SIZE) {
    const { error } = await resend.batch.send(messages.slice(index, index + RESEND_BATCH_SIZE));
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return Response.json({
    ok: true,
    period: {
      startDate: current.startDate,
      endDate: current.endDate,
      label: current.label,
    },
    scanned: recipients.length,
    sent: messages.length,
    skipped: recipients.length - messages.length,
  });
}
