import { getEarnedBadges } from "./badges";
import { summarizeDailyAggregateRows } from "./daily-aggregate-summary";
import { computeLongestStreak } from "./wrapped";

type AggregateRow = {
  date: string;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalReasoning: number;
  clientsUsed: string[];
  modelsUsed: string[];
};

type SubmittedRecord = {
  timestamp: Date;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  client: string;
  model: string;
};

function getBadgeContext({ rows }: { rows: AggregateRow[] }) {
  const summary = summarizeDailyAggregateRows({ rows });

  return {
    totalTokens: summary.totalTokens,
    longestStreak: computeLongestStreak({
      dates: rows.map((row) => row.date),
    }),
    clientCount: summary.clients.length,
    modelCount: summary.models.length,
    cacheHitRate: summary.cacheHitRate,
    activeDays: summary.activeDays,
  };
}

function projectAggregateRows({
  rows,
  records,
}: {
  rows: AggregateRow[];
  records: SubmittedRecord[];
}) {
  const map = new Map<string, AggregateRow & { clientSet: Set<string>; modelSet: Set<string> }>();

  for (const row of rows) {
    map.set(row.date, {
      ...row,
      clientSet: new Set(row.clientsUsed),
      modelSet: new Set(row.modelsUsed),
    });
  }

  for (const record of records) {
    const date = record.timestamp.toISOString().slice(0, 10);
    const existing = map.get(date) ?? {
      date,
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      totalReasoning: 0,
      clientsUsed: [],
      modelsUsed: [],
      clientSet: new Set<string>(),
      modelSet: new Set<string>(),
    };

    existing.totalInput += record.inputTokens;
    existing.totalOutput += record.outputTokens;
    existing.totalCacheRead += record.cacheReadTokens;
    existing.totalCacheWrite += record.cacheWriteTokens;
    existing.totalReasoning += record.reasoningTokens;
    existing.clientSet.add(record.client);
    existing.modelSet.add(record.model);
    map.set(date, existing);
  }

  return [...map.values()]
    .map(({ clientSet, modelSet, ...row }) => ({
      ...row,
      clientsUsed: [...clientSet],
      modelsUsed: [...modelSet],
    }))
    .toSorted((a, b) => b.date.localeCompare(a.date));
}

export function getUnlockedBadges({
  rows,
  records,
}: {
  rows: AggregateRow[];
  records: SubmittedRecord[];
}) {
  const currentBadges = getEarnedBadges({
    context: getBadgeContext({ rows }),
  });
  const nextBadges = getEarnedBadges({
    context: getBadgeContext({
      rows: projectAggregateRows({ rows, records }),
    }),
  });
  const currentIds = new Set(currentBadges.map((badge) => badge.id));

  return nextBadges.filter((badge) => !currentIds.has(badge.id));
}
