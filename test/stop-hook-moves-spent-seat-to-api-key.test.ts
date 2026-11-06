import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { account, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

test("the Stop hook of a supervised session whose only account is past its weekly bar writes a respawn marker onto a stored API key, stamped with the child's launch time", async () => {
  const root = mkdtempSync(join(tmpdir(), "tokenmaxxing-stop-hook-"));
  try {
    const tm = join(root, "tokenmaxxing");
    mkdirSync(join(tm, "api-keys"), { recursive: true });
    const now = Date.now();
    const id = crypto.randomUUID();
    const seat = { ...account(id, "max 5x", [sessionWindow(40, now + 2 * HOUR_MS, now), weeklyWindow(99, now + 3 * 24 * HOUR_MS, now)]), lastUsageAt: now, lastProbeAt: now };
    writeFileSync(join(tm, "accounts.json"), JSON.stringify({ version: 2, accounts: [seat] }));
    writeFileSync(join(tm, "api-keys.json"), JSON.stringify({ version: 1, keys: [{ id: "spare", label: "spare", spentUsd: 0, addedAt: now }], baselines: {} }));
    writeFileSync(join(tm, "api-keys", "spare"), "sk-ant-test\n", { mode: 0o600 });

    const sid = crypto.randomUUID();
    const launchedAt = now - 60_000;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("TOKENMAXXING_") && !key.startsWith("CLAUDE_")) env[key] = value;
    }
    Object.assign(env, {
      HOME: root,
      TOKENMAXXING_HOME: tm,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: join(tm, "stores", id.slice(0, 8)),
      TOKENMAXXING_SUPERVISED: "1",
      TOKENMAXXING_SESSION_ID: sid,
      TOKENMAXXING_LAUNCHED_AT: String(launchedAt),
      TOKENMAXXING_MODEL: "",
      TOKENMAXXING_REFUSED: "",
      TOKENMAXXING_API_KEY_ID: "",
    });

    const hook = Bun.spawn([process.execPath, MAIN, "__stop-hook"], { env, stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, hook_event_name: "Stop" })), stdout: "pipe", stderr: "pipe" });
    const [exitCode, stderr] = await Promise.all([hook.exited, hook.stderr.text()]);

    const markerPath = join(tm, "respawn", sid);
    const marker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : null;
    const log = existsSync(join(tm, "tokenmaxxing.log")) ? readFileSync(join(tm, "tokenmaxxing.log"), "utf8") : "";
    expect({ exitCode, stderr, log, marker }).toMatchObject({
      exitCode: 0,
      marker: { apiKeyId: "spare", accountId: "", sessionId: sid, launchedAt, origin: "stop", compact: true },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
