import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { sessionHash } from "./utils";

const FACTORY_DIR = join(homedir(), ".factory", "sessions");

interface FactorySession {
  model?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    thinkingTokens?: number;
  };
}

export const factoryDroid: ClientParser = {
  client: "factory-droid",
  async detect() { return existsSync(FACTORY_DIR); },
  async *parse(): AsyncGenerator<UsageRecord> {
    for await (const file of glob(join(FACTORY_DIR, "*.settings.json"))) {
      let session: FactorySession;
      try { session = JSON.parse(readFileSync(file, "utf-8")); } catch { continue; }
      const t = session.tokenUsage;
      if (!t) continue;
      const input = t.inputTokens ?? 0;
      const output = t.outputTokens ?? 0;
      if (input + output === 0) continue;
      yield { client: "factory-droid", model: session.model ?? "unknown", sessionHash: sessionHash("factory-droid", file), timestamp: new Date().toISOString(), tokens: { input, output, cacheRead: t.cacheReadTokens ?? 0, cacheWrite: t.cacheCreationTokens ?? 0, reasoning: t.thinkingTokens ?? 0 }, costUsd: 0 };
    }
  },
};
