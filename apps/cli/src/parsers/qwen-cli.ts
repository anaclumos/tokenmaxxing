import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { readJsonl, sessionHash } from "./utils";

const QWEN_DIR = join(homedir(), ".qwen", "projects");

interface QwenEntry {
  type?: string;
  model?: string;
  timestamp?: string;
  sessionId?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

export const qwenCli: ClientParser = {
  client: "qwen-cli",
  async detect() { return existsSync(QWEN_DIR); },
  async *parse(): AsyncGenerator<UsageRecord> {
    const sessions = new Map<string, { model: string; ts: string; input: number; output: number; cached: number; thoughts: number }>();
    for await (const file of glob(join(QWEN_DIR, "**", "chats", "*.jsonl"))) {
      for await (const e of readJsonl<QwenEntry>(file)) {
        const u = e.usageMetadata;
        if (!u) continue;
        const sid = e.sessionId ?? file;
        const prev = sessions.get(sid);
        const input = u.promptTokenCount ?? 0;
        const output = u.candidatesTokenCount ?? 0;
        const cached = u.cachedContentTokenCount ?? 0;
        const thoughts = u.thoughtsTokenCount ?? 0;
        if (prev) {
          prev.input += input; prev.output += output; prev.cached += cached; prev.thoughts += thoughts;
          if (e.model) prev.model = e.model;
          if (e.timestamp) prev.ts = e.timestamp;
        } else {
          sessions.set(sid, { model: e.model ?? "unknown", ts: e.timestamp ?? "", input, output, cached, thoughts });
        }
      }
    }
    for (const [sid, s] of sessions) {
      if (s.input + s.output === 0) continue;
      yield { client: "qwen-cli", model: s.model, sessionHash: sessionHash("qwen-cli", sid), timestamp: s.ts || new Date().toISOString(), tokens: { input: s.input, output: s.output, cacheRead: s.cached, cacheWrite: 0, reasoning: s.thoughts }, costUsd: 0 };
    }
  },
};
