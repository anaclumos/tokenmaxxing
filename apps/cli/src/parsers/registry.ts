import type { ClientParser } from "./types";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import { geminiCli } from "./gemini-cli";
import { opencode } from "./opencode";
import { ampcode } from "./ampcode";
import { cursor } from "./cursor";
import { rooCode, kiloCode } from "./roo-code";
import { openclaw } from "./openclaw";
import { piAgent } from "./pi-agent";
import { kimi } from "./kimi";
import { qwenCli } from "./qwen-cli";
import { factoryDroid } from "./factory-droid";
import { mux } from "./mux";

const ALL_PARSERS: ClientParser[] = [
  claudeCode, codex, geminiCli, opencode, ampcode, cursor,
  rooCode, kiloCode, openclaw, piAgent, kimi, qwenCli, factoryDroid, mux,
];

export async function discoverClients(): Promise<ClientParser[]> {
  const found: ClientParser[] = [];
  for (const parser of ALL_PARSERS) {
    if (await parser.detect()) {
      found.push(parser);
    }
  }
  return found;
}

export async function parseAll(parsers: ClientParser[]): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  for (const parser of parsers) {
    for await (const record of parser.parse()) {
      records.push(record);
    }
  }
  return records;
}
