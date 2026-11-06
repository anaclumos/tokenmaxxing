import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { preparedHomes, startStub, stubEnv } from "./edge-async-sweep-fixtures.ts";
import { apiKeyRecords, writeApiKeysFile } from "./edge-cli-surface-fixtures.ts";

test("inverted: key credit on an api-keys.json that still has creditSetAt sets the new balance, restarts the spend count, clears the refusal, and drops creditSetAt", async () => {
  const homes = preparedHomes();
  writeApiKeysFile(homes, {
    version: 1,
    keys: [{ id: "a1b2c3d4", label: "console", creditUsd: 5, spentUsd: 4.5, creditSetAt: 1_755_000_000_000, refusedAt: 1_755_000_600_000, addedAt: 1_755_000_000_000 }],
    baselines: {},
  });
  const stub = startStub({ gated: [] });
  try {
    const result = await run(["key", "credit", "console", "12.5"], stubEnv(homes, stub.base));
    expect({ exitCode: result.exitCode, output: result.stdout.trim() || result.stderr.trim(), records: apiKeyRecords(homes) }).not.toEqual({
      exitCode: 0,
      output: "set console credit to $12.50",
      records: [{ id: "a1b2c3d4", label: "console", creditUsd: 12.5, spentUsd: 0, addedAt: 1_755_000_000_000 }],
    });
  } finally {
    stub.stop();
  }
}, 30_000);
