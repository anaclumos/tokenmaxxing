import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { pooledClaudeAccount, preparedHomes, startStub, stubEnv, writeClaudePool } from "./edge-async-sweep-fixtures.ts";
import { labeled, poolHeaders, writePool } from "./edge-cli-surface-fixtures.ts";

test("status --cached heads each non-Claude pool with its account count in pool order, marking only grok, cursor, and kimi status-only", async () => {
  const homes = preparedHomes();
  writeClaudePool(homes, [pooledClaudeAccount("6bde0c87-b09d-4f4e-9c7c-8de03f9b5ea6")]);
  writePool(homes, "kimi", [labeled("7cef1d98-c1ae-4a5f-8d8d-9ef14a0c6fb7", "kimi-one", "moderato"), labeled("8df02ea9-d2bf-4b6a-9e9e-af025b1d7ac8", "kimi-two", "moderato")]);
  writePool(homes, "cursor", [labeled("9e013fba-e3c0-4c7b-8faf-b0136c2e8bd9", "cursor-one", "pro")]);
  writePool(homes, "muse", [labeled("af1240cb-f4d1-4d8c-9ab0-c1247d3f9cea", "muse-one", "pro")]);
  writePool(homes, "grok", [labeled("b02351dc-05e2-4e9d-8bc1-d2358e4a0dfb", "grok-one", "supergrok")]);
  writePool(homes, "codex", [labeled("c13462ed-16f3-4fae-9cd2-e3469f5b1e0c", "codex-one", "pro")]);
  const stub = startStub({ gated: [] });
  try {
    const result = await run(["status", "--cached"], stubEnv(homes, stub.base));
    expect({ exitCode: result.exitCode, headers: poolHeaders(result.stdout), stderr: result.stderr }).toMatchObject({
      exitCode: 0,
      headers: ["codex  (1 account)", "grok  (1 account, status-only)", "muse  (1 account)", "cursor  (1 account, status-only)", "kimi  (2 accounts, status-only)"],
    });
  } finally {
    stub.stop();
  }
}, 30_000);
