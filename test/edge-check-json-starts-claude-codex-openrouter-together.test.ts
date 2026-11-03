import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import {
  codexAccountAtWeeklyBar,
  logTail,
  parseJson,
  pooledClaudeAccount,
  preparedHomes,
  startStub,
  stubEnv,
  writeClaudePool,
  writeClaudeStore,
  writeCodexPool,
  writeCodexStore,
  writeOpenRouterKey,
} from "./edge-async-sweep-fixtures.ts";

const CLAUDE_ID = "6c1f0d2e-8a3b-4c5d-9e7f-1a2b3c4d5e6f";
const CODEX_ID = "b84e2f17-3c9d-4e1a-8f6b-2d7c5e9a0b13";

test("check --json sends the Claude sample, the Codex reset claim, and the OpenRouter credit read before any of them is answered", async () => {
  const now = Date.now();
  const homes = preparedHomes();
  writeClaudePool(homes, [pooledClaudeAccount(CLAUDE_ID)]);
  writeClaudeStore(homes, CLAUDE_ID, "sk-ant-oat01-tick-sample");
  writeCodexPool(homes, [codexAccountAtWeeklyBar(CODEX_ID, now)]);
  writeCodexStore(homes, CODEX_ID);
  writeOpenRouterKey(homes, now);
  const stub = startStub({ gated: ["claude-usage", "codex-reset", "openrouter-key"] });
  try {
    const result = await run(["check", "--json"], stubEnv(homes, stub.base));
    const doc = parseJson(result.stdout);
    expect({ exitCode: result.exitCode, doc, stderr: result.stderr, log: logTail(homes) }).toMatchObject({
      exitCode: 0,
      doc: { ok: true, swapped: false, reason: "under-threshold-or-stale" },
    });
    expect(Object.keys(doc ?? {})).toEqual(expect.arrayContaining(["account", "waitUntil"]));
    expect(stub.seen.map((s) => s.kind)).toEqual(expect.arrayContaining(["claude-usage", "codex-reset", "openrouter-key"]));
  } finally {
    stub.stop();
  }
}, 30_000);
