import { z } from "zod";

// All supported AI coding agents
export const SupportedClient = z.enum([
  "claude-code",
  "codex",
  "gemini-cli",
  "opencode",
  "ampcode",
  "cursor",
  "roo-code",
  "kilocode",
  "openclaw",
  "pi-agent",
  "kimi",
  "qwen-cli",
  "factory-droid",
  "mux",
]);
export type SupportedClient = z.infer<typeof SupportedClient>;

// Token breakdown - the core unit of measurement
export const TokenBreakdown = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
});
export type TokenBreakdown = z.infer<typeof TokenBreakdown>;

// What the CLI sends to the server per usage record
export const UsageRecord = z.object({
  client: SupportedClient,
  model: z.string().min(1),
  sessionHash: z.string().length(64), // SHA-256 hex
  timestamp: z.string().datetime(),
  tokens: TokenBreakdown,
  costUsd: z.number().nonnegative(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;

// Batch submission payload
export const SubmitPayload = z.object({
  records: z.array(UsageRecord).min(1).max(500),
});
export type SubmitPayload = z.infer<typeof SubmitPayload>;

// Submission response
export const SubmitResponse = z.object({
  inserted: z.number(),
  skipped: z.number(),
  total: z.number(),
});
export type SubmitResponse = z.infer<typeof SubmitResponse>;

// Leaderboard periods
export const LeaderboardPeriod = z.enum(["daily", "weekly", "monthly", "alltime"]);
export type LeaderboardPeriod = z.infer<typeof LeaderboardPeriod>;

// Leaderboard entry (what the API returns)
export const LeaderboardEntry = z.object({
  rank: z.number().int().positive(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  totalTokens: z.number(),
  totalCost: z.number(),
  compositeScore: z.number(),
  topClient: SupportedClient.nullable(),
  streak: z.number().int().nonnegative(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntry>;

// Utility: total tokens from a breakdown
export function totalTokens(t: TokenBreakdown): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.reasoning;
}
