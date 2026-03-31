import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { sessionHash } from "./utils";

// Roo Code stores tasks in VS Code's globalStorage
function getVscodeGlobalStorage(extensionId: string): string {
  const platform = process.platform;
  const base = platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : join(homedir(), ".config");
  return join(base, "Code", "User", "globalStorage", extensionId, "tasks");
}

const ROO_DIR = getVscodeGlobalStorage("rooveterinaryinc.roo-cline");

interface UiMessage {
  type?: string;
  say?: string;
  text?: string;
  ts?: number;
}

function parseRooTasks(dir: string, client: "roo-code" | "kilocode") {
  return async function* (): AsyncGenerator<UsageRecord> {
    if (!existsSync(dir)) return;
    for await (const file of glob(join(dir, "*", "ui_messages.json"))) {
      let messages: UiMessage[];
      try { messages = JSON.parse(readFileSync(file, "utf-8")); } catch { continue; }
      if (!Array.isArray(messages)) continue;

      let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0;
      let lastTs = 0;

      for (const msg of messages) {
        if (msg.say !== "api_req_started" || !msg.text) continue;
        let parsed: { tokensIn?: number; tokensOut?: number; cacheReads?: number; cacheWrites?: number };
        try { parsed = JSON.parse(msg.text); } catch { continue; }
        totalIn += parsed.tokensIn ?? 0;
        totalOut += parsed.tokensOut ?? 0;
        totalCacheRead += parsed.cacheReads ?? 0;
        totalCacheWrite += parsed.cacheWrites ?? 0;
        if (msg.ts) lastTs = msg.ts;
      }

      if (totalIn + totalOut === 0) continue;
      yield { client, model: "unknown", sessionHash: sessionHash(client, file), timestamp: lastTs ? new Date(lastTs).toISOString() : new Date().toISOString(), tokens: { input: totalIn, output: totalOut, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, reasoning: 0 }, costUsd: 0 };
    }
  };
}

export const rooCode: ClientParser = {
  client: "roo-code",
  async detect() { return existsSync(ROO_DIR); },
  parse: parseRooTasks(ROO_DIR, "roo-code"),
};

const KILO_DIR = getVscodeGlobalStorage("kilocode.kilo-code");

export const kiloCode: ClientParser = {
  client: "kilocode",
  async detect() { return existsSync(KILO_DIR); },
  parse: parseRooTasks(KILO_DIR, "kilocode"),
};
