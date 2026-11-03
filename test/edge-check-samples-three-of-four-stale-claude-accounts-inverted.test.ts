import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { logTail, pooledClaudeAccount, preparedHomes, readPool, startStub, stubEnv, unnamedFigures, writeClaudePool, writeClaudeStore } from "./edge-async-sweep-fixtures.ts";

const IDS = ["0b3e6a91-2c4d-4e7f-8a1b-5c9d3e7f1a20", "7d2f9c04-6e1a-4b3c-9d8e-0f5a2b6c8d13", "c5a81e37-4f9b-4d2a-b6c0-8e3f1d5a7b46", "e8f40b72-3a6c-4c1e-a9d2-6b0e4f8a2c57"];

test("inverted control: a check tick over four never-sampled Claude accounts samples all four", async () => {
  const homes = preparedHomes();
  writeClaudePool(homes, IDS.map((id) => pooledClaudeAccount(id)));
  for (const [i, id] of IDS.entries()) writeClaudeStore(homes, id, `sk-ant-oat01-batch-${i}`);
  const stub = startStub({});
  try {
    const result = await run(["check"], stubEnv(homes, stub.base));
    const figures = readPool(homes, "accounts.json").map((a) => unnamedFigures(a));
    expect({
      exitCode: result.exitCode,
      usageReads: stub.count("claude-usage"),
      sampled: figures.filter((f) => f.length > 0).length,
      unsampled: figures.filter((f) => f.length === 0).length,
      stdout: result.stdout,
      stderr: result.stderr,
      log: logTail(homes),
    }).toMatchObject({
      exitCode: 0,
      usageReads: 4,
      sampled: 4,
      unsampled: 0,
    });
  } finally {
    stub.stop();
  }
}, 30_000);
