import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { sessionHash } from "./utils";

const AMP_DIR = join(homedir(), ".local", "share", "amp", "threads");

interface AmpThread {
  id?: string;
  created?: string;
  usageLedger?: {
    events?: Array<{
      timestamp?: string;
      model?: string;
      tokens?: {
        input?: number;
        output?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      };
    }>;
  };
}

export const ampcode: ClientParser = {
  client: "ampcode",

  async detect() {
    return existsSync(AMP_DIR);
  },

  async *parse(): AsyncGenerator<UsageRecord> {
    for await (const file of glob(join(AMP_DIR, "T-*.json"))) {
      let thread: AmpThread;
      try {
        thread = JSON.parse(readFileSync(file, "utf-8"));
      } catch {
        continue;
      }

      const events = thread.usageLedger?.events;
      if (!events?.length) continue;

      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let model = "unknown";
      let lastTimestamp = thread.created ?? "";

      for (const event of events) {
        const t = event.tokens;
        if (!t) continue;
        totalInput += t.input ?? 0;
        totalOutput += t.output ?? 0;
        totalCacheRead += t.cacheReadInputTokens ?? 0;
        totalCacheWrite += t.cacheCreationInputTokens ?? 0;
        if (event.model) model = event.model;
        if (event.timestamp) lastTimestamp = event.timestamp;
      }

      if (totalInput + totalOutput === 0) continue;

      yield {
        client: "ampcode",
        model,
        sessionHash: sessionHash("ampcode", thread.id ?? file),
        timestamp: lastTimestamp || new Date().toISOString(),
        tokens: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, reasoning: 0 },
        costUsd: 0,
      };
    }
  },
};
