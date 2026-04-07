import { userInfo } from "node:os";
import { extname, resolve } from "node:path";

import { computeLongestStreak, type WrappedSvgData } from "@tokenmaxxing/shared/wrapped";
import { totalTokens, type UsageRecord } from "@tokenmaxxing/shared/types";

export function getWrappedOutputPath({
  output,
  username,
  year,
}: {
  output?: string;
  username: string;
  year: number;
}) {
  return resolve(output ?? `${username}-wrapped-${year}.png`);
}

export function getWrappedOutputFormat({ outputPath }: { outputPath: string }) {
  const extension = extname(outputPath).toLowerCase();

  if (extension === ".svg") return "svg";
  if (extension === ".png") return "png";

  throw new Error(`Unsupported wrapped output format: ${extension || "(none)"}`);
}

export function getWrappedUsername() {
  return userInfo().username;
}

export function buildLocalWrappedData({
  records,
  username,
  year,
}: {
  records: UsageRecord[];
  username: string;
  year: number;
}): WrappedSvgData | null {
  const yearRecords = records.filter((record) => {
    return new Date(record.timestamp).getUTCFullYear() === year;
  });

  if (yearRecords.length === 0) return null;

  const activityMap = new Map<string, number>();
  const clientTotals = new Map<string, number>();
  const modelTotals = new Map<string, number>();
  let totalTokenCount = 0;
  let totalCost = 0;

  for (const record of yearRecords) {
    const tokenCount = totalTokens(record.tokens);
    const date = new Date(record.timestamp).toISOString().slice(0, 10);

    totalTokenCount += tokenCount;
    totalCost += record.costUsd;
    activityMap.set(date, (activityMap.get(date) ?? 0) + tokenCount);
    clientTotals.set(record.client, (clientTotals.get(record.client) ?? 0) + tokenCount);
    modelTotals.set(record.model, (modelTotals.get(record.model) ?? 0) + tokenCount);
  }

  return {
    username,
    year,
    totalTokens: totalTokenCount,
    totalCost,
    activeDays: activityMap.size,
    messages: yearRecords.length,
    longestStreak: computeLongestStreak({
      dates: [...activityMap.keys()],
    }),
    rank: null,
    topClients: [...clientTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name),
    topModels: [...modelTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name),
    activityMap,
  };
}
