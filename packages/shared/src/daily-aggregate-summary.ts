import { sumAggregateTokens } from "./types";

export type DailyAggregateSummaryRow = {
  date: string;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalReasoning: number;
  modelsUsed?: string[] | null;
  clientsUsed?: string[] | null;
};

export function summarizeDailyAggregateRows({ rows }: { rows: DailyAggregateSummaryRow[] }) {
  const breakdown = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
  const modelSet = new Set<string>();
  const clientSet = new Set<string>();
  const activity = rows.map((row) => ({
    date: row.date,
    tokens: sumAggregateTokens(row),
  }));

  for (const row of rows) {
    breakdown.input += row.totalInput;
    breakdown.output += row.totalOutput;
    breakdown.cacheRead += row.totalCacheRead;
    breakdown.cacheWrite += row.totalCacheWrite;
    breakdown.reasoning += row.totalReasoning;
    for (const model of row.modelsUsed ?? []) modelSet.add(model);
    for (const client of row.clientsUsed ?? []) clientSet.add(client);
  }

  const cachePool = breakdown.input + breakdown.cacheRead;

  return {
    breakdown,
    totalTokens: sumAggregateTokens({
      totalInput: breakdown.input,
      totalOutput: breakdown.output,
      totalCacheRead: breakdown.cacheRead,
      totalCacheWrite: breakdown.cacheWrite,
      totalReasoning: breakdown.reasoning,
    }),
    cachePool,
    cacheHitRate: cachePool > 0 ? (breakdown.cacheRead / cachePool) * 100 : 0,
    models: [...modelSet].toSorted(),
    clients: [...clientSet].toSorted(),
    activeDays: rows.length,
    activity,
    activityMap: new Map(activity.map((entry) => [entry.date, entry.tokens])),
  };
}
