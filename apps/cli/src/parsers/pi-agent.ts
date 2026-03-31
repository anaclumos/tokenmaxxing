import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { readJsonl, sessionHash } from "./utils";

const PI_DIR = join(homedir(), ".pi", "agent", "sessions");

interface PiEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  };
}

export const piAgent: ClientParser = {
  client: "pi-agent",
  async detect() { return existsSync(PI_DIR); },
  async *parse(): AsyncGenerator<UsageRecord> {
    for await (const file of glob(join(PI_DIR, "**", "*.jsonl"))) {
      let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
      let model = "unknown", lastTs = "", sid = "";
      for await (const e of readJsonl<PiEntry>(file)) {
        // First line is session header
        if (e.type === "session" && e.id) { sid = e.id; continue; }
        const u = e.message?.usage;
        if (!u) continue;
        input += u.input ?? 0;
        output += u.output ?? 0;
        cacheRead += u.cacheRead ?? 0;
        cacheWrite += u.cacheWrite ?? 0;
        if (e.message?.model) model = e.message.model;
        if (e.timestamp) lastTs = e.timestamp;
      }
      if (input + output === 0) continue;
      yield { client: "pi-agent", model, sessionHash: sessionHash("pi-agent", sid || file), timestamp: lastTs || new Date().toISOString(), tokens: { input, output, cacheRead, cacheWrite, reasoning: 0 }, costUsd: 0 };
    }
  },
};
