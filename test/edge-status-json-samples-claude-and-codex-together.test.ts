import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { logTail, parseJson, preparedHomes, startStub, stubEnv, writeClaudePool, writeClaudeStore, writeCodexPool, writeCodexStore } from "./edge-async-sweep-fixtures.ts";
import { account, pooledClaude } from "./fixtures.ts";

const CLAUDE_ID = "5f8b1d3a-0e2c-4a9b-8d7e-3c1f5a9b2e60";
const CODEX_ID = "a26c9e54-8b1f-4d3a-9e0c-7f2b4d6a8c15";
const POOLS = ["claude", "codex", "grok", "muse", "cursor", "kimi", "vibe"];

test("status --json sends the Claude and Codex usage reads before either is answered and still reports the pools in their fixed order", async () => {
  const homes = preparedHomes();
  writeClaudePool(homes, [pooledClaude(CLAUDE_ID)]);
  writeClaudeStore(homes, CLAUDE_ID, "sk-ant-oat01-status-together");
  writeCodexPool(homes, [account(CODEX_ID, "pro", [])]);
  writeCodexStore(homes, CODEX_ID);
  const stub = startStub({ gated: ["claude-usage", "codex-usage"] });
  try {
    const result = await run(["status", "--json"], stubEnv(homes, stub.base));
    const doc = parseJson(result.stdout);
    expect({ exitCode: result.exitCode, doc, stderr: result.stderr, log: logTail(homes) }).toMatchObject({
      exitCode: 0,
      doc: {
        ok: true,
        claude: { accounts: [{ id: CLAUDE_ID, sample: { ok: true }, usage: { fiveHour: { usedPercentage: 10 }, week: { usedPercentage: 20 } } }] },
        codex: { accounts: [{ id: CODEX_ID }] },
      },
    });
    expect(Object.keys(doc ?? {}).filter((k) => POOLS.includes(k))).toEqual(POOLS);
    expect(stub.seen.map((s) => s.kind)).toEqual(expect.arrayContaining(["claude-usage", "codex-usage"]));
  } finally {
    stub.stop();
  }
}, 30_000);
