import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import {
  codexAccountAtWeeklyBar,
  logTail,
  OPENROUTER_KEY_ID,
  pooledClaudeAccount,
  preparedHomes,
  readApiKeys,
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

const CLAUDE_ID = "2e9a7c41-5b6d-4f8e-a1c3-7d9e0f2b4a6c";
const CODEX_ID = "f03b8d62-1e4a-4c7b-9d5f-6a8c2e0b3d91";

test("inverted control: one check tick leaves the OpenRouter credit left at its stored value", async () => {
  const now = Date.now();
  const homes = preparedHomes();
  writeClaudePool(homes, [pooledClaudeAccount(CLAUDE_ID)]);
  writeClaudeStore(homes, CLAUDE_ID, "sk-ant-oat01-tick-saves");
  writeCodexPool(homes, [codexAccountAtWeeklyBar(CODEX_ID, now)]);
  writeCodexStore(homes, CODEX_ID);
  writeOpenRouterKey(homes, now);
  const stub = startStub({});
  try {
    const result = await run(["check"], stubEnv(homes, stub.base));
    const claude = readPool(homes, "accounts.json").find((a) => a.id === CLAUDE_ID);
    const codex = readPool(homes, "codex-accounts.json").find((a) => a.id === CODEX_ID);
    const key = readApiKeys(homes).keys.find((k) => k.id === OPENROUTER_KEY_ID);
    expect({
      exitCode: result.exitCode,
      claudeFigures: unnamedFigures(claude),
      codexClaims: stub.count("codex-reset"),
      codexStillAtWeeklyBar: unnamedFigures(codex).some((p) => p >= 98),
      openrouterRemaining: key?.openrouter?.remainingUsd,
      stdout: result.stdout,
      stderr: result.stderr,
      log: logTail(homes),
    }).toMatchObject({
      exitCode: 0,
      claudeFigures: [10, 20],
      codexClaims: 1,
      codexStillAtWeeklyBar: false,
      openrouterRemaining: 3,
    });
  } finally {
    stub.stop();
  }
}, 30_000);
