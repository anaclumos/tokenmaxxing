import { expect, test } from "bun:test";
import { preparedHomes, stubEnv } from "./edge-async-sweep-fixtures.ts";
import { apiKeyRecords, runWithStdin, serveOpenRouter } from "./edge-cli-surface-fixtures.ts";

test("inverted: key add stores an Anthropic key with its entered credit and an OpenRouter key with OpenRouter's credit, neither with creditSetAt", async () => {
  const homes = preparedHomes();
  const openrouter = serveOpenRouter([7.25]);
  try {
    const env = stubEnv(homes, openrouter.base);
    const anthropic = await runWithStdin(["key", "add", "console", "20"], env, "sk-ant-api03-edge-console-key\n");
    const router = await runWithStdin(["key", "add", "router"], env, "sk-or-v1-edge-router-key\n");
    const records = apiKeyRecords(homes);
    expect({
      exitCodes: [anthropic.exitCode, router.exitCode],
      fields: records.map((k) => Object.keys(k).toSorted()),
      records,
      stderr: [anthropic.stderr, router.stderr],
    }).not.toMatchObject({
      exitCodes: [0, 0],
      fields: [
        ["addedAt", "creditUsd", "id", "label", "spentUsd"],
        ["addedAt", "id", "label", "openrouter", "spentUsd"],
      ],
      records: [
        { label: "console", creditUsd: 20, spentUsd: 0, addedAt: expect.any(Number) },
        { label: "router", spentUsd: 0, addedAt: expect.any(Number), openrouter: { remainingUsd: 7.25, at: expect.any(Number) } },
      ],
    });
  } finally {
    openrouter.stop();
  }
}, 30_000);
