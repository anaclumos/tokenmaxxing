import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { glob } from "node:fs/promises";
import type { UsageRecord } from "@tokenmaxxing/shared/types";
import type { ClientParser } from "./types";
import { readJsonFile, sessionHash, projectFromCwd } from "./utils";

const DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");
const LEGACY_DIR = join(homedir(), ".local", "share", "opencode", "storage", "message");

export const opencode: ClientParser = {
  client: "opencode",

  async detect() {
    return existsSync(DB_PATH) || existsSync(LEGACY_DIR);
  },

  async *parse(): AsyncGenerator<UsageRecord> {
    // SQLite path (primary)
    if (existsSync(DB_PATH)) {
      const { Database } = await import("bun:sqlite");
      const db = new Database(DB_PATH, { readonly: true });

      const rows = db.query(`
        SELECT m.id, m.time_created, m.data, s.directory
        FROM message m
        LEFT JOIN session s ON m.session_id = s.id
        WHERE json_extract(m.data, '$.role') = 'assistant'
          AND json_extract(m.data, '$.tokens') IS NOT NULL
      `).all() as Array<{ id: string; time_created: number; data: string; directory: string | null }>;

      for (const row of rows) {
        const d = JSON.parse(row.data) as {
          modelID?: string;
          cost?: number;
          tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
          time?: { created?: number };
        };

        const t = d.tokens;
        if (!t) continue;

        yield {
          client: "opencode",
          model: d.modelID ?? "unknown",
          sessionHash: sessionHash("opencode", row.id),
          timestamp: new Date(d.time?.created ?? row.time_created).toISOString(),
          tokens: {
            input: t.input ?? 0,
            output: t.output ?? 0,
            cacheRead: t.cache?.read ?? 0,
            cacheWrite: t.cache?.write ?? 0,
            reasoning: t.reasoning ?? 0,
          },
          costUsd: d.cost ?? 0,
          project: row.directory ? projectFromCwd(row.directory) : undefined,
        };
      }

      db.close();
      return;
    }

    // Legacy JSON path
    for await (const file of glob(join(LEGACY_DIR, "**", "*.json"))) {
      const msg: {
        role?: string;
        modelID?: string;
        cost?: number;
        tokens?: {
          input?: number;
          output?: number;
          reasoning?: number;
          cache?: { read?: number; write?: number };
        };
        time?: { created?: string };
      } = readJsonFile(file)

      if (msg.role !== "assistant" || !msg.tokens) continue;

      yield {
        client: "opencode",
        model: msg.modelID ?? "unknown",
        sessionHash: sessionHash("opencode", file),
        timestamp: msg.time?.created ?? new Date().toISOString(),
        tokens: {
          input: msg.tokens.input ?? 0,
          output: msg.tokens.output ?? 0,
          cacheRead: msg.tokens.cache?.read ?? 0,
          cacheWrite: msg.tokens.cache?.write ?? 0,
          reasoning: msg.tokens.reasoning ?? 0,
        },
        costUsd: msg.cost ?? 0,
      };
    }
  },
};
