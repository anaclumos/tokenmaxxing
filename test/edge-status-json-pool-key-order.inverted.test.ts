import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { parseJson, preparedHomes, startStub, stubEnv, writeClaudePool } from "./edge-async-sweep-fixtures.ts";
import { pooledClaude } from "./fixtures.ts";
import { labeled, poolIds, writeApiKeysFile, writePool } from "./edge-cli-surface-fixtures.ts";

const IDS = {
  claude: "0b7e4c21-5a3d-4f8e-9c16-2d8a7f3b9e40",
  codex: "1c8f5d32-6b4e-4a9f-8d27-3e9b8a4c0f51",
  grok: "2d9a6e43-7c5f-4b0a-9e38-4fac9b5d1a62",
  muse: "3eab7f54-8d6a-4c1b-8f49-5abd0c6e2b73",
  cursor: "4fbc8a65-9e7b-4d2c-9a5a-6bce1d7f3c84",
  kimi: "5acd9b76-af8c-4e3d-8b6b-7cdf2e8a4d95",
};

test("inverted: status --json --cached lists now, the six pools in their fixed order, and then the API keys, each pool carrying its own accounts", async () => {
  const homes = preparedHomes();
  writeClaudePool(homes, [pooledClaude(IDS.claude)]);
  writePool(homes, "codex", [labeled(IDS.codex, "codex-one", "pro")]);
  writePool(homes, "grok", [labeled(IDS.grok, "grok-one", "supergrok")]);
  writePool(homes, "muse", [labeled(IDS.muse, "muse-one", "pro")]);
  writePool(homes, "cursor", [labeled(IDS.cursor, "cursor-one", "pro")]);
  writePool(homes, "kimi", [labeled(IDS.kimi, "kimi-one", "moderato")]);
  writeApiKeysFile(homes, { version: 1, keys: [{ id: "9f3a1c7e", label: "spare", creditUsd: 10, spentUsd: 2.5, addedAt: 1_760_000_000_000 }], baselines: {} });
  const stub = startStub({ gated: [] });
  try {
    const result = await run(["status", "--json", "--cached"], stubEnv(homes, stub.base));
    const doc = parseJson(result.stdout);
    const observed = {
      exitCode: result.exitCode,
      keys: Object.keys(doc ?? {}),
      pools: { claude: poolIds(doc, "claude"), codex: poolIds(doc, "codex"), grok: poolIds(doc, "grok"), muse: poolIds(doc, "muse"), cursor: poolIds(doc, "cursor"), kimi: poolIds(doc, "kimi") },
      apiKeys: doc?.apiKeys,
    };
    expect(observed).not.toMatchObject({
      exitCode: 0,
      keys: ["ok", "now", "claude", "codex", "grok", "muse", "cursor", "kimi", "apiKeys"],
      pools: { claude: [IDS.claude], codex: [IDS.codex], grok: [IDS.grok], muse: [IDS.muse], cursor: [IDS.cursor], kimi: [IDS.kimi] },
      apiKeys: [{ label: "spare", creditUsd: 10, spentUsd: 2.5, creditLeftUsd: 7.5 }],
    });
    expect(stub.seen).toEqual([]);
  } finally {
    stub.stop();
  }
}, 30_000);
