import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { logTail, parseJson, pooledClaudeAccount, preparedHomes, readPool, startStub, stubEnv, unnamedFigures, writeClaudePool, writeClaudeStore } from "./edge-async-sweep-fixtures.ts";

const CLAUDE_ID = "38e1f5b2-7a0d-4c6e-9b3f-1d5a8c2e0f94";

test("status --json fails when the Codex pool's index is unreadable, and the Claude pool still samples and saves its fresh figures", async () => {
  const homes = preparedHomes();
  writeClaudePool(homes, [pooledClaudeAccount(CLAUDE_ID)]);
  writeClaudeStore(homes, CLAUDE_ID, "sk-ant-oat01-status-broken-codex");
  writeFileSync(join(homes.state, "codex-accounts.json"), JSON.stringify({ version: 1, accounts: [] }));
  const stub = startStub({});
  try {
    const result = await run(["status", "--json"], stubEnv(homes, stub.base));
    const doc = parseJson(result.stdout);
    const error = doc?.error;
    const claude = readPool(homes, "accounts.json").find((a) => a.id === CLAUDE_ID);
    expect({
      failed: result.exitCode !== 0,
      ok: doc?.ok,
      hasError: typeof error === "string" && error.length > 0,
      claudeFigures: unnamedFigures(claude),
      stdout: result.stdout,
      stderr: result.stderr,
      log: logTail(homes),
    }).toMatchObject({
      failed: true,
      ok: false,
      hasError: true,
      claudeFigures: [10, 20],
    });
  } finally {
    stub.stop();
  }
}, 30_000);
