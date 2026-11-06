import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { preparedHomes, startStub, stubEnv } from "./edge-async-sweep-fixtures.ts";
import { labeled, poolHeaders, writePool } from "./edge-cli-surface-fixtures.ts";

test("status --cached with only a kimi account says no claude accounts and shows the kimi pool instead of the no-accounts message", async () => {
  const homes = preparedHomes();
  writePool(homes, "kimi", [labeled("d24573fe-2704-40bf-8de3-f457a06c2f1d", "kimi-only", "moderato")]);
  const stub = startStub({ gated: [] });
  try {
    const result = await run(["status", "--cached"], stubEnv(homes, stub.base));
    const lines = result.stdout.split("\n");
    expect({
      exitCode: result.exitCode,
      noClaudeLine: lines.includes("no claude accounts (run `tokenmaxxing init` to pool claude too)"),
      noAccountsMessage: result.stdout.includes("no accounts yet"),
      headers: poolHeaders(result.stdout),
      stdout: result.stdout,
    }).toMatchObject({ exitCode: 0, noClaudeLine: true, noAccountsMessage: false, headers: ["kimi  (1 account, status-only)"] });
  } finally {
    stub.stop();
  }
}, 30_000);
