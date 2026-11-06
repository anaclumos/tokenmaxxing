import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Account } from "../src/lib/types.ts";
import { account, claudeCredentials, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

const DAY_MS = 24 * HOUR_MS;

export const CLOSED_URL = "http://127.0.0.1:9";

export const IDS = {
  work: "3f1c2a7e-5b8d-4c6a-9e2f-1a7b3c5d9e01",
  spare: "8a4e6c2b-1d3f-4b7a-8c9e-2f5a7b1c3d02",
  backup: "c7d9e1f3-a5b2-4c8d-9e6f-3a1b5c7d9e03",
  session: "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e04",
} as const;

export function pooled(input: { id: string; label: string; tier: string; sessionUsed: number; weeklyUsed: number; now: number }): Account {
  return {
    ...account(input.id, input.tier, [sessionWindow(input.sessionUsed, input.now + 3 * HOUR_MS, input.now), weeklyWindow(input.weeklyUsed, input.now + 5 * DAY_MS, input.now)]),
    label: input.label,
    lastUsageAt: input.now,
    lastProbeAt: input.now,
  };
}

export function writeClaudeStoreBlob(home: string, id: string, blob: string): void {
  const dir = join(home, "stores", id.slice(0, 8));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".credentials.json"), blob, { mode: 0o600 });
}

const CLEARED_STORE = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] } });

export async function clearedStoreMove(home: string) {
  process.env.TOKENMAXXING_OAUTH_USAGE_URL = `${CLOSED_URL}/api/oauth/usage`;
  delete process.env.TOKENMAXXING_MODEL;
  const now = Date.now();
  const { claudePool } = await import("../src/lib/paths.ts");
  const { loadAccounts, saveAccounts } = await import("../src/lib/state.ts");
  const { claude } = await import("../src/lib/claude.ts");
  const { evaluateAndMaybeSwap } = await import("../src/lib/decide.ts");
  saveAccounts(claudePool, {
    version: 2,
    accounts: [
      pooled({ id: IDS.work, label: "work", tier: "max", sessionUsed: 95, weeklyUsed: 30, now }),
      pooled({ id: IDS.spare, label: "spare", tier: "max", sessionUsed: 5, weeklyUsed: 10, now }),
      pooled({ id: IDS.backup, label: "backup", tier: "max", sessionUsed: 40, weeklyUsed: 50, now }),
    ],
  });
  writeClaudeStoreBlob(home, IDS.work, claudeCredentials("work-token", now + 5 * HOUR_MS));
  writeClaudeStoreBlob(home, IDS.spare, CLEARED_STORE);
  writeClaudeStoreBlob(home, IDS.backup, claudeCredentials("backup-token", now + 5 * HOUR_MS));
  const decision = await evaluateAndMaybeSwap(claude, now, true, null, { seatId: IDS.work, waiterId: IDS.session });
  return { decision, accounts: loadAccounts(claudePool).accounts };
}

export function logFields(home: string, event: string): string[] {
  const path = join(home, "tokenmaxxing.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.split(" "))
    .filter((parts) => parts[1] === event)
    .map((parts) => parts.slice(2).join(" "));
}

export const COMPACT_THREAD = "019a6b2e-7c4d-7f10-9a3b-5c6d7e8f9a01";

const RecordedSchema = z.looseObject({ method: z.string() });

export async function compactWithFakeAppServer(onCompact: unknown[]): Promise<{ requests: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "codex-appserver-stub-"));
  const record = join(dir, "requests.jsonl");
  const bin = join(dir, "codex");
  const lines = (msgs: unknown[]) => msgs.map((m) => `'${JSON.stringify(m)}'`).join(" ");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'while IFS= read -r line; do',
      '  printf \'%s\\n\' "$line" >> "$FAKE_RECORD"',
      '  case "$line" in',
      `    *'"method":"initialize"'*) printf '%s\\n' ${lines([{ id: 1, result: { userAgent: "fake-codex" } }])} ;;`,
      `    *'"method":"thread/resume"'*) printf '%s\\n' ${lines([{ id: 2, result: { thread: { id: COMPACT_THREAD } } }])} ;;`,
      `    *'"method":"thread/compact/start"'*) printf '%s\\n' ${lines([{ id: 3, result: {} }, ...onCompact])} ;;`,
      "  esac",
      "done",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  const { compactCodexThread } = await import("../src/lib/compact.ts");
  await compactCodexThread({ real: bin, threadId: COMPACT_THREAD, env: { PATH: process.env.PATH, FAKE_RECORD: record } });
  const requests = existsSync(record)
    ? readFileSync(record, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => RecordedSchema.parse(JSON.parse(line)).method)
    : [];
  return { requests };
}
