import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { readJsonFile, sessionHash } from "./utils";

const GEMINI_DIR = join(homedir(), ".gemini", "tmp");

interface GeminiMessage {
  type?: string;
  model?: string;
  timestamp?: string;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
    total?: number;
  };
}

interface GeminiSession {
  sessionId?: string;
  messages?: GeminiMessage[];
}

export const geminiCli: ClientParser = {
  client: "gemini-cli",

  async detect() {
    return existsSync(GEMINI_DIR);
  },

  async *parse(): AsyncGenerator<UsageRecord> {
    // Gemini stores session JSON files in nested directories
    for await (const file of glob(join(GEMINI_DIR, "**", "*.json"))) {
      const session: GeminiSession = readJsonFile(file)

      if (!session.messages || !Array.isArray(session.messages)) continue;

      let totalInput = 0;
      let totalOutput = 0;
      let totalCached = 0;
      let totalThoughts = 0;
      let model = "unknown";
      let lastTimestamp = "";

      for (const msg of session.messages) {
        if (!msg.tokens) continue;
        totalInput += msg.tokens.input ?? 0;
        totalOutput += msg.tokens.output ?? 0;
        totalCached += msg.tokens.cached ?? 0;
        totalThoughts += msg.tokens.thoughts ?? 0;
        if (msg.model) model = msg.model;
        if (msg.timestamp) lastTimestamp = msg.timestamp;
      }

      if (totalInput + totalOutput === 0) continue;

      const sid = session.sessionId ?? file;
      yield {
        client: "gemini-cli",
        model,
        sessionHash: sessionHash("gemini-cli", sid),
        timestamp: lastTimestamp || new Date().toISOString(),
        tokens: {
          input: totalInput,
          output: totalOutput,
          cacheRead: totalCached,
          cacheWrite: 0,
          reasoning: totalThoughts,
        },
        costUsd: 0,
      };
    }
  },
};
