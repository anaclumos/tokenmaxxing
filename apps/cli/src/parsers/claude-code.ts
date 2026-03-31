import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { readJsonl, sessionHash } from "./utils";

const CLAUDE_DIR = join(homedir(), ".claude", "projects");

// Claude Code JSONL entry shape (only fields we care about)
interface ClaudeEntry {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  costUSD?: number;
}

export const claudeCode: ClientParser = {
  client: "claude-code",

  async detect() {
    return existsSync(CLAUDE_DIR);
  },

  async *parse(): AsyncGenerator<UsageRecord> {
    // Aggregate tokens per session to avoid per-message granularity
    const sessions = new Map<
      string,
      {
        model: string;
        timestamp: string;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
      }
    >();

    for await (const file of glob(join(CLAUDE_DIR, "**", "*.jsonl"))) {
      for await (const entry of readJsonl<ClaudeEntry>(file)) {
        if (entry.type !== "assistant" || !entry.message?.usage) continue;

        const sid = entry.sessionId ?? file;
        const usage = entry.message.usage;
        const existing = sessions.get(sid);

        if (existing) {
          existing.input += usage.input_tokens ?? 0;
          existing.output += usage.output_tokens ?? 0;
          existing.cacheRead += usage.cache_read_input_tokens ?? 0;
          existing.cacheWrite += usage.cache_creation_input_tokens ?? 0;
          existing.cost += entry.costUSD ?? 0;
          if (entry.timestamp) existing.timestamp = entry.timestamp;
          if (entry.message.model) existing.model = entry.message.model;
        } else {
          sessions.set(sid, {
            model: entry.message.model ?? "unknown",
            timestamp: entry.timestamp ?? new Date().toISOString(),
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
            cost: entry.costUSD ?? 0,
          });
        }
      }
    }

    for (const [sid, s] of sessions) {
      yield {
        client: "claude-code",
        model: s.model,
        sessionHash: sessionHash("claude-code", sid),
        timestamp: s.timestamp,
        tokens: {
          input: s.input,
          output: s.output,
          cacheRead: s.cacheRead,
          cacheWrite: s.cacheWrite,
          reasoning: 0,
        },
        costUsd: s.cost,
      };
    }
  },
};
