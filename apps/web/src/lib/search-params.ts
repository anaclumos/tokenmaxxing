export const leaderboardPeriods = [
  "daily",
  "weekly",
  "monthly",
  "alltime",
] as const;

export type LeaderboardPeriod = (typeof leaderboardPeriods)[number];

export const leaderboardSorts = ["score", "tokens", "cost"] as const;

export type LeaderboardSort = (typeof leaderboardSorts)[number];

const analyticsDayRanges = [7, 30, 90, 0] as const;

export type AnalyticsDayRange = (typeof analyticsDayRanges)[number];

export function parseLeaderboardPeriod(value?: string): LeaderboardPeriod {
  return leaderboardPeriods.find((period) => period === value) ?? "alltime";
}

export function parseLeaderboardSort(value?: string): LeaderboardSort {
  return leaderboardSorts.find((sort) => sort === value) ?? "score";
}

export function parseAnalyticsDayRange(value?: string): AnalyticsDayRange {
  const days = Number(value);
  return analyticsDayRanges.find((candidate) => candidate === days) ?? 30;
}

export function parsePage(value?: string): number {
  return Math.max(1, Number(value ?? 1) || 1);
}
