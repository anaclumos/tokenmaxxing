import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { logTail, parseJson, pooledClaudeAccount, preparedHomes, startStub, stubEnv, writeClaudePool, writeClaudeStore } from "./edge-async-sweep-fixtures.ts";
import { HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

const CLAUDE_ID = "d47a0c96-3b5e-4f1d-a8c2-9e6b0d4f2a73";

test("status --cached --json renders the stored Claude figures and sends no request to any endpoint", async () => {
  const now = Date.now();
  const sampledAt = now - 10 * 60_000;
  const homes = preparedHomes();
  writeClaudePool(homes, [
    {
      ...pooledClaudeAccount(CLAUDE_ID, [
        { ...sessionWindow(55, now + 2 * HOUR_MS, now), sampledAt },
        { ...weeklyWindow(66, now + 4 * 24 * HOUR_MS, now), sampledAt },
      ]),
      lastUsageAt: sampledAt,
    },
  ]);
  writeClaudeStore(homes, CLAUDE_ID, "sk-ant-oat01-status-cached");
  const stub = startStub({});
  try {
    const result = await run(["status", "--cached", "--json"], stubEnv(homes, stub.base));
    expect({ exitCode: result.exitCode, doc: parseJson(result.stdout), requests: stub.seen, stderr: result.stderr, log: logTail(homes) }).toMatchObject({
      exitCode: 0,
      doc: { ok: true, claude: { accounts: [{ id: CLAUDE_ID, usage: { fiveHour: { usedPercentage: 55 }, week: { usedPercentage: 66 } } }] } },
      requests: [],
    });
  } finally {
    stub.stop();
  }
}, 30_000);
