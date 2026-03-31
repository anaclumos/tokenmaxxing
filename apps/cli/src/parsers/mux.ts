import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { readJsonFile, sessionHash } from "./utils";

const MUX_DIR = join(homedir(), ".mux", "sessions");

interface MuxUsage {
  byModel?: Record<string, {
    input?: { tokens?: number };
    output?: { tokens?: number };
    cached?: { tokens?: number };
    cacheCreate?: { tokens?: number };
    reasoning?: { tokens?: number };
  }>;
  lastRequest?: { timestamp?: string };
}

export const mux: ClientParser = {
  client: "mux",
  async detect() { return existsSync(MUX_DIR); },
  async *parse(): AsyncGenerator<UsageRecord> {
    for await (const file of glob(join(MUX_DIR, "*", "session-usage.json"))) {
      const data: MuxUsage = readJsonFile(file)
      if (!data.byModel) continue;
      for (const [model, usage] of Object.entries(data.byModel)) {
        const input = usage.input?.tokens ?? 0;
        const output = usage.output?.tokens ?? 0;
        if (input + output === 0) continue;
        yield { client: "mux", model, sessionHash: sessionHash("mux", `${file}:${model}`), timestamp: data.lastRequest?.timestamp ?? new Date().toISOString(), tokens: { input, output, cacheRead: usage.cached?.tokens ?? 0, cacheWrite: usage.cacheCreate?.tokens ?? 0, reasoning: usage.reasoning?.tokens ?? 0 }, costUsd: 0 };
      }
    }
  },
};
