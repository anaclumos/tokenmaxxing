import { sql } from "drizzle-orm";
import { createDb } from "@tokenmaxxing/db/index";
import { dailyAggregates } from "@tokenmaxxing/db/index";

let _db: ReturnType<typeof createDb>;

export function db() {
  _db ??= createDb(process.env.DATABASE_URL!);
  return _db;
}

// Sum of all token columns in daily_aggregates - used by dashboard, profile, and API queries
export const totalTokensSql = sql<number>`${dailyAggregates.totalInput} + ${dailyAggregates.totalOutput} + ${dailyAggregates.totalCacheRead} + ${dailyAggregates.totalCacheWrite} + ${dailyAggregates.totalReasoning}`;
