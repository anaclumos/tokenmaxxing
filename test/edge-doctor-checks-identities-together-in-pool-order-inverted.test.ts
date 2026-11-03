import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { answer, bearer, logTail, pooledClaudeAccount, preparedHomes, profileBody, startStub, stubEnv, writeClaudePool, writeClaudeStore } from "./edge-async-sweep-fixtures.ts";

const POOL = [
  { id: "e19d4b62-0a7c-4f3e-b2d8-5c1a9e7f3b04", token: "sk-ant-oat01-doctor-first" },
  { id: "3a7f0e85-6c2b-4d9a-8e1f-0b4c7d2a5e96", token: "sk-ant-oat01-doctor-second" },
  { id: "9c5e2a17-4d8f-4b0c-a3e6-1f7b9d0c2e48", token: "sk-ant-oat01-doctor-third" },
];

test("inverted control: doctor with every identity check gated together prints the verdicts in reverse pool order", async () => {
  const homes = preparedHomes();
  writeClaudePool(homes, POOL.map((p) => pooledClaudeAccount(p.id)));
  for (const p of POOL) writeClaudeStore(homes, p.id, p.token);
  const stub = startStub({
    gated: POOL.map((p) => `profile:${p.token}`),
    keyOf: (req, kind) => (kind === "claude-profile" ? `profile:${bearer(req)}` : kind),
    respond: (kind, req) => {
      const owner = POOL.find((p) => p.token === bearer(req));
      return kind === "claude-profile" && owner ? Response.json(profileBody(owner.id)) : answer(kind, req);
    },
  });
  try {
    const result = await run(["doctor"], stubEnv(homes, stub.base));
    const output = `${result.stdout}\n${result.stderr}`;
    const positions = POOL.map((p) => output.indexOf(p.id.slice(0, 8)));
    expect({ positions, output, log: logTail(homes) }).toMatchObject({
      positions: [...positions].sort((a, b) => b - a),
    });
  } finally {
    stub.stop();
  }
}, 30_000);
