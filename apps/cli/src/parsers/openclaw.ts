import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { readJsonl, sessionHash } from "./utils";

// Check all legacy paths
const PATHS = [
  join(homedir(), ".openclaw", "agents"),
  join(homedir(), ".clawdbot", "agents"),
  join(homedir(), ".moltbot", "agents"),
];

interface OpenClawEntry {
  type?: string;
  message?: {
    role?: string;
    model?: string;
    timestamp?: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  };
}

export const openclaw: ClientParser = {
  client: "openclaw",
  async detect() { return PATHS.some((p) => existsSync(p)); },
  async *parse(): AsyncGenerator<UsageRecord> {
    for (const dir of PATHS) {
      if (!existsSync(dir)) continue;
      for await (const file of glob(join(dir, "**", "*.jsonl"))) {
        let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
        let model = "unknown", lastTs = "";
        for await (const e of readJsonl<OpenClawEntry>(file)) {
          const u = e.message?.usage;
          if (!u) continue;
          input += u.input ?? 0;
          output += u.output ?? 0;
          cacheRead += u.cacheRead ?? 0;
          cacheWrite += u.cacheWrite ?? 0;
          if (e.message?.model) model = e.message.model;
          if (e.message?.timestamp) lastTs = e.message.timestamp;
        }
        if (input + output === 0) continue;
        yield {
          client: "openclaw",
          model,
          sessionHash: sessionHash("openclaw", file),
          timestamp: lastTs || new Date().toISOString(),
          tokens: { input, output, cacheRead, cacheWrite, reasoning: 0 },
          costUsd: 0,
        };
      }
    }
  },
};
