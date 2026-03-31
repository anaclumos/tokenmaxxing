import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { sessionHash } from "./utils";

// Cursor usage data is fetched from their API and cached locally by tokscale
// We check the same cache location for compatibility
const CACHE_DIR = join(homedir(), ".config", "tokenmaxxing", "cursor-cache");
const CACHE_FILE = join(CACHE_DIR, "usage.csv");

// Cursor also has a local SQLite DB but it doesn't contain token usage
const CURSOR_DB = join(
  homedir(),
  process.platform === "darwin" ? "Library/Application Support" : ".config",
  "Cursor",
  "User",
  "globalStorage",
  "state.vscdb",
);

export const cursor: ClientParser = {
  client: "cursor",

  async detect() {
    // Detect if Cursor is installed (even without cached usage data)
    return existsSync(CURSOR_DB) || existsSync(CACHE_FILE);
  },

  async *parse(): AsyncGenerator<UsageRecord> {
    // Only parse if we have cached CSV data
    // Users need to export their usage from cursor.com/settings first
    if (!existsSync(CACHE_FILE)) return;

    const csv = readFileSync(CACHE_FILE, "utf-8");
    const lines = csv.trim().split("\n");
    if (lines.length < 2) return; // Header only

    // CSV: Date, Kind, Model, Max Mode, Input (w/ Cache Write), Input (w/o Cache Write), Cache Read, Output Tokens, Total Tokens, Cost
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim());
      if (cols.length < 10) continue;

      const [date, , model, , inputWithCache, inputWithoutCache, cacheRead, outputTokens, , cost] = cols;
      const input = Number(inputWithoutCache) || 0;
      const output = Number(outputTokens) || 0;
      const cached = Number(cacheRead) || 0;
      const cacheWrite = (Number(inputWithCache) || 0) - input;

      if (input + output === 0) continue;

      yield {
        client: "cursor",
        model: model || "unknown",
        sessionHash: sessionHash("cursor", `${date}:${model}:${i}`),
        timestamp: new Date(date).toISOString(),
        tokens: { input, output, cacheRead: cached, cacheWrite: Math.max(0, cacheWrite), reasoning: 0 },
        costUsd: Number(cost) || 0,
      };
    }
  },
};
