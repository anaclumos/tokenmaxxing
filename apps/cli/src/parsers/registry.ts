import type { ClientParser } from "./types";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import { geminiCli } from "./gemini-cli";
import { opencode } from "./opencode";
import { ampcode } from "./ampcode";

// Register all parsers here. Add new parsers as they're implemented.
const ALL_PARSERS: ClientParser[] = [claudeCode, codex, geminiCli, opencode, ampcode];

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
