import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { logTail, pooledClaudeAccount, preparedHomes, startStub, stubEnv, writeClaudePool, writeClaudeStore } from "./edge-async-sweep-fixtures.ts";

const IDS = ["4b9e1c73-8d2a-4f6e-b0c5-3a7d9e1f5b28", "a7d30f58-2e6b-4c9a-8f1d-5b0e3c7a9d64", "1f6c8e24-7b3d-4a0f-9c5e-8d2a6b4f0e39"];

test("inverted control: auth --all over a Claude pool whose every store is usable exits 1", async () => {
  const homes = preparedHomes();
  writeClaudePool(homes, IDS.map((id) => pooledClaudeAccount(id)));
  for (const [i, id] of IDS.entries()) writeClaudeStore(homes, id, `sk-ant-oat01-auth-all-${i}`);
  const stub = startStub({});
  try {
    const result = await run(["auth", "--all"], stubEnv(homes, stub.base));
    expect({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, log: logTail(homes) }).toMatchObject({ exitCode: 1 });
  } finally {
    stub.stop();
  }
}, 30_000);
