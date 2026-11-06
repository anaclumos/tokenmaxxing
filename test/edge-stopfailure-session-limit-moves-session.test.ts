import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { AccountsIndexSchema, RespawnMarkerSchema } from "../src/lib/types.ts";
import { HOUR_MS } from "./fixtures.ts";
import { logTail, preparedHomes, startStub, stubEnv, writeClaudePool, writeClaudeStore } from "./edge-async-sweep-fixtures.ts";
import { IDS, pooled } from "./edge-minesweep-fixtures.ts";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
const LIMIT_TEXT = "Claude usage limit reached. Your limit will reset at 5pm.";
const LAUNCHED_AT = 1_762_400_000_000;

test("a supervised session that hits its five-hour limit walls the account until the transcript's reset and writes a respawn marker for the other account", async () => {
  const homes = preparedHomes();
  const now = Date.now();
  const resetsAtSeconds = Math.floor((now + 2 * HOUR_MS) / 1000);
  writeClaudePool(homes, [pooled({ id: IDS.work, label: "work", tier: "max", sessionUsed: 60, weeklyUsed: 30, now }), pooled({ id: IDS.backup, label: "backup", tier: "max", sessionUsed: 10, weeklyUsed: 20, now })]);
  writeClaudeStore(homes, IDS.work, "sk-ant-oat01-work-seat");
  writeClaudeStore(homes, IDS.backup, "sk-ant-oat01-backup-seat");
  const transcript = join(homes.home, "transcript.jsonl");
  const row = { type: "assistant", isApiErrorMessage: true, error: "rate_limit", quotaLimits: { rateLimitType: "five_hour", resetsAt: resetsAtSeconds }, message: { content: [{ type: "text", text: LIMIT_TEXT }] } };
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "keep going" } })}\n${JSON.stringify(row)}\n`);
  const stub = startStub({ gated: [] });
  try {
    const proc = Bun.spawn([process.execPath, MAIN, "__stop-failure-hook"], {
      env: {
        ...stubEnv(homes, stub.base),
        CLAUDE_SECURESTORAGE_CONFIG_DIR: join(homes.state, "stores", IDS.work.slice(0, 8)),
        TOKENMAXXING_SUPERVISED: "1",
        TOKENMAXXING_SESSION_ID: IDS.session,
        TOKENMAXXING_LAUNCHED_AT: String(LAUNCHED_AT),
      },
      cwd: ROOT,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: IDS.session, transcript_path: transcript, error: "rate_limit", last_assistant_message: LIMIT_TEXT })),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const markerPath = join(homes.state, "respawn", IDS.session);
    const marker = existsSync(markerPath) ? RespawnMarkerSchema.parse(JSON.parse(readFileSync(markerPath, "utf8"))) : null;
    const work = AccountsIndexSchema.parse(JSON.parse(readFileSync(join(homes.state, "accounts.json"), "utf8"))).accounts.find((a) => a.id === IDS.work);

    expect({ exitCode, marker, enforcedUntil: work?.enforcedUntil, stdout, stderr, log: logTail(homes) }).toMatchObject({
      exitCode: 0,
      marker: { accountId: IDS.backup, sessionId: IDS.session, origin: "stopfailure", compact: false, launchedAt: LAUNCHED_AT },
      enforcedUntil: resetsAtSeconds * 1000,
    });
  } finally {
    stub.stop();
  }
}, 30_000);
