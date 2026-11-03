import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import {
  answer,
  codexAccountAtWeeklyBar,
  logTail,
  pooledClaudeAccount,
  preparedHomes,
  readPool,
  startStub,
  stubEnv,
  unnamedFigures,
  writeClaudePool,
  writeClaudeStore,
  writeCodexPool,
  writeCodexStore,
  writeOpenRouterKey,
} from "./edge-async-sweep-fixtures.ts";

const CLAUDE_ID = "9a4c2e18-7f3b-4d6a-b5e1-0c8d2f4a6b79";
const CODEX_ID = "41d7b0e3-9c2a-4f5e-8b1d-3e6a9c0f2d58";

test("inverted control: a check tick whose OpenRouter credit read fails exits 0 without check failed", async () => {
  const now = Date.now();
  const homes = preparedHomes();
  writeClaudePool(homes, [pooledClaudeAccount(CLAUDE_ID)]);
  writeClaudeStore(homes, CLAUDE_ID, "sk-ant-oat01-tick-failure");
  writeCodexPool(homes, [codexAccountAtWeeklyBar(CODEX_ID, now)]);
  writeCodexStore(homes, CODEX_ID);
  writeOpenRouterKey(homes, now);
  const stub = startStub({
    gated: ["claude-usage", "codex-reset", "openrouter-key"],
    respond: (kind, req) =>
      kind === "openrouter-key" ? Response.json({ error: { code: 500, message: "Internal Server Error" } }, { status: 500 }) : answer(kind, req),
  });
  try {
    const result = await run(["check"], stubEnv(homes, stub.base));
    const claude = readPool(homes, "accounts.json").find((a) => a.id === CLAUDE_ID);
    expect({
      exitCode: result.exitCode,
      reportsCheckFailed: (result.stdout + result.stderr).includes("check failed:"),
      claudeFigures: unnamedFigures(claude),
      codexClaims: stub.count("codex-reset"),
      stdout: result.stdout,
      stderr: result.stderr,
      log: logTail(homes),
    }).toMatchObject({
      exitCode: 0,
      reportsCheckFailed: false,
    });
  } finally {
    stub.stop();
  }
}, 30_000);
