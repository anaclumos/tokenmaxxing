import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { readJsonl, sessionHash, projectFromCwd } from "./utils";

const CODEX_DIRS = [
  join(homedir(), ".codex", "sessions"),
  join(homedir(), ".codex", "archived_sessions"),
];

// Codex JSONL entry - total_token_usage is cumulative, we need deltas
interface CodexEntry {
  type?: string;
  timestamp?: string;
  payload?: {
    cwd?: string;
    model?: string;
    model_provider?: string;
    info?: {
      total_token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
        reasoning_output_tokens?: number;
      };
    };
  };
}


export const codex: ClientParser = {
  client: "codex",

  async detect() {
    return CODEX_DIRS.some((d) => existsSync(d));
  },

  async *parse(): AsyncGenerator<UsageRecord> {
    for (const dir of CODEX_DIRS) {
      if (!existsSync(dir)) continue;

      for await (const file of glob(join(dir, "**", "*.jsonl"))) {
        // Track cumulative totals per file to compute deltas
        let prevInput = 0;
        let prevOutput = 0;
        let prevCached = 0;
        let prevReasoning = 0;
        let totalInput = 0;
        let totalOutput = 0;
        let totalCached = 0;
        let totalReasoning = 0;
        let model = "unknown";
        let lastTimestamp = "";
        let project: string | undefined;
        const sid = file; // session ID = file path

        for await (const entry of readJsonl<CodexEntry>(file)) {
          if (entry.type === "session_meta" && entry.payload?.cwd) {
            project = projectFromCwd(entry.payload.cwd);
          }
          const usage = entry.payload?.info?.total_token_usage;
          if (!usage) continue;

          // Compute deltas from cumulative values
          const curInput = usage.input_tokens ?? 0;
          const curOutput = usage.output_tokens ?? 0;
          const curCached = usage.cached_input_tokens ?? 0;
          const curReasoning = usage.reasoning_output_tokens ?? 0;

          totalInput += Math.max(0, curInput - prevInput);
          totalOutput += Math.max(0, curOutput - prevOutput);
          totalCached += Math.max(0, curCached - prevCached);
          totalReasoning += Math.max(0, curReasoning - prevReasoning);

          prevInput = curInput;
          prevOutput = curOutput;
          prevCached = curCached;
          prevReasoning = curReasoning;

          if (entry.payload?.model) model = entry.payload.model;
          if (entry.timestamp) lastTimestamp = entry.timestamp;
        }

        if (totalInput + totalOutput === 0) continue;

        yield {
          client: "codex",
          model,
          sessionHash: sessionHash("codex", sid),
          timestamp: lastTimestamp || new Date().toISOString(),
          tokens: {
            input: totalInput,
            output: totalOutput,
            cacheRead: totalCached,
            cacheWrite: 0,
            reasoning: totalReasoning,
          },
          costUsd: 0, // filled by pricing engine
          project,
        };
      }
    }
  },
};
