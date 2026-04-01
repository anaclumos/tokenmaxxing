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
  timestamp: z.iso.datetime(),
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

export const CliStatusResponse = z.object({
  user: z.object({
    username: z.string().min(1),
    totalTokens: z.number().int().nonnegative(),
    totalCost: z.coerce.number().nonnegative(),
    streak: z.number().int().nonnegative(),
    longestStreak: z.number().int().nonnegative(),
  }),
  ranks: z.object({
    global: z.object({ rank: z.number().int().positive() }).nullable(),
  }),
});
export type CliStatusResponse = z.infer<typeof CliStatusResponse>;

// Utility: total tokens from a breakdown
export function totalTokens(t: TokenBreakdown): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + t.reasoning;
}

// Utility: total tokens from daily aggregate fields (totalInput, totalOutput, etc.)
export function sumAggregateTokens(a: {
  totalInput: number | null;
  totalOutput: number | null;
  totalCacheRead: number | null;
  totalCacheWrite: number | null;
  totalReasoning: number | null;
}): number {
  return (a.totalInput ?? 0) + (a.totalOutput ?? 0) + (a.totalCacheRead ?? 0) + (a.totalCacheWrite ?? 0) + (a.totalReasoning ?? 0);
}

// Utility: human-readable token count (2.4B, 150M, 42K)
export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}
