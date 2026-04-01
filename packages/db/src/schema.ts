import {
  bigint,
  boolean,
  date,
  decimal,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Enums
export const leaderboardPeriod = pgEnum("leaderboard_period", [
  "daily",
  "weekly",
  "monthly",
  "alltime",
]);

// Users - synced from Clerk via webhook
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  clerkId: varchar("clerk_id", { length: 255 }).notNull().unique(),
  username: varchar("username", { length: 64 }).notNull().unique(),
  avatarUrl: text("avatar_url"),
  email: varchar("email", { length: 255 }),
  totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
  totalCost: decimal("total_cost", { precision: 12, scale: 4 }).notNull().default("0"),
  currentStreak: integer("current_streak").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
  privacyMode: boolean("privacy_mode").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Raw usage records - one per session/message from any AI agent
export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    client: varchar("client", { length: 32 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    sessionHash: varchar("session_hash", { length: 64 }).notNull().unique(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull(),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull(),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }).notNull(),
    costUsd: decimal("cost_usd", { precision: 12, scale: 6 }).notNull(),
    project: text("project"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_records_user_id_idx").on(t.userId),
    index("usage_records_timestamp_idx").on(t.timestamp),
    index("usage_records_user_timestamp_idx").on(t.userId, t.timestamp),
  ],
);

// Pre-computed daily aggregates per user
export const dailyAggregates = pgTable(
  "daily_aggregates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    totalInput: bigint("total_input", { mode: "number" }).notNull().default(0),
    totalOutput: bigint("total_output", { mode: "number" }).notNull().default(0),
    totalCacheRead: bigint("total_cache_read", { mode: "number" }).notNull().default(0),
    totalCacheWrite: bigint("total_cache_write", { mode: "number" }).notNull().default(0),
    totalReasoning: bigint("total_reasoning", { mode: "number" }).notNull().default(0),
    totalCost: decimal("total_cost", { precision: 12, scale: 6 }).notNull().default("0"),
    sessionCount: integer("session_count").notNull().default(0),
    clientsUsed: text("clients_used").array().notNull().default([]),
    modelsUsed: text("models_used").array().notNull().default([]),
  },
  (t) => [
    unique("daily_agg_user_date_uniq").on(t.userId, t.date),
    index("daily_agg_user_id_idx").on(t.userId),
    index("daily_agg_date_idx").on(t.date),
  ],
);

// Pre-computed rankings for leaderboards
export const rankings = pgTable(
  "rankings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    leaderboardId: varchar("leaderboard_id", { length: 255 }).notNull(), // "global" or clerk org ID
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    period: leaderboardPeriod("period").notNull(),
    periodStart: date("period_start").notNull(),
    rank: integer("rank").notNull(),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull(),
    totalCost: decimal("total_cost", { precision: 12, scale: 4 }).notNull(),
    compositeScore: decimal("composite_score", { precision: 12, scale: 4 }).notNull(),
  },
  (t) => [
    unique("rankings_uniq").on(t.leaderboardId, t.userId, t.period, t.periodStart),
    index("rankings_leaderboard_period_idx").on(t.leaderboardId, t.period, t.rank),
  ],
);

// API tokens for CLI authentication
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    prefix: varchar("prefix", { length: 12 }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_tokens_user_id_idx").on(t.userId)],
);

// Type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UsageRecordRow = typeof usageRecords.$inferSelect;
export type NewUsageRecord = typeof usageRecords.$inferInsert;
export type DailyAggregate = typeof dailyAggregates.$inferSelect;
export type Ranking = typeof rankings.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
