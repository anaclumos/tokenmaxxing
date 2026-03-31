import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { readJsonFile, readJsonl, sessionHash } from "./utils";

const KIMI_DIR = join(homedir(), ".kimi", "sessions");
const KIMI_CONFIG = join(homedir(), ".kimi", "config.json");

interface KimiEntry {
  timestamp?: number; // Unix seconds float
  message?: {
    type?: string;
    payload?: {
      token_usage?: {
        input_other?: number;
        output?: number;
        input_cache_read?: number;
        input_cache_creation?: number;
      };
      message_id?: string;
    };
  };
}

export const kimi: ClientParser = {
  client: "kimi",
  async detect() { return existsSync(KIMI_DIR); },
  async *parse(): AsyncGenerator<UsageRecord> {
    // Read model from config
    let model = "unknown";
    if (existsSync(KIMI_CONFIG)) {
      const cfg: {
        model?: string;
      } = readJsonFile(KIMI_CONFIG)
      if (cfg.model) model = cfg.model;
    }

    for await (const file of glob(join(KIMI_DIR, "**", "wire.jsonl"))) {
      let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
      let lastTs = 0;
      for await (const e of readJsonl<KimiEntry>(file)) {
        const u = e.message?.payload?.token_usage;
        if (!u) continue;
        input += u.input_other ?? 0;
        output += u.output ?? 0;
        cacheRead += u.input_cache_read ?? 0;
        cacheWrite += u.input_cache_creation ?? 0;
        if (e.timestamp) lastTs = e.timestamp;
      }
      if (input + output === 0) continue;
      yield { client: "kimi", model, sessionHash: sessionHash("kimi", file), timestamp: lastTs ? new Date(lastTs * 1000).toISOString() : new Date().toISOString(), tokens: { input, output, cacheRead, cacheWrite, reasoning: 0 }, costUsd: 0 };
    }
  },
};
