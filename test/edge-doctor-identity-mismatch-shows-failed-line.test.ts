import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { answer, bearer, logTail, pooledClaudeAccount, preparedHomes, profileBody, startStub, stubEnv, writeClaudePool, writeClaudeStore } from "./edge-async-sweep-fixtures.ts";

const MISMATCHED = { id: "71b3d9e0-5f2a-4c8d-9e6b-0a4f2c8e6d13", token: "sk-ant-oat01-doctor-mismatch" };
const MATCHED = { id: "c08e4a2f-9b1d-4e7c-a5f3-2d6b8e0a4c71", token: "sk-ant-oat01-doctor-match" };
const STRANGER = "5e2c7a90-1d4f-4b8e-8c3a-6f0d2b9e4a17";

function verdictLines(output: string, id: string): string {
  return output
    .split("\n")
    .filter((line) => line.includes(id.slice(0, 8)))
    .map((line) => line.replaceAll(id, "<id>").replaceAll(id.slice(0, 8), "<id8>"))
    .join("\n");
}

test("doctor shows a failed line for a store whose token belongs to another account, while the matching store's line passes", async () => {
  const homes = preparedHomes();
  writeClaudePool(homes, [pooledClaudeAccount(MISMATCHED.id), pooledClaudeAccount(MATCHED.id)]);
  writeClaudeStore(homes, MISMATCHED.id, MISMATCHED.token);
  writeClaudeStore(homes, MATCHED.id, MATCHED.token);
  const stub = startStub({
    respond: (kind, req) => {
      if (kind !== "claude-profile") return answer(kind, req);
      return Response.json(profileBody(bearer(req) === MISMATCHED.token ? STRANGER : MATCHED.id));
    },
  });
  try {
    const result = await run(["doctor"], stubEnv(homes, stub.base));
    const output = `${result.stdout}\n${result.stderr}`;
    const mismatched = verdictLines(output, MISMATCHED.id);
    const matched = verdictLines(output, MATCHED.id);
    expect({ hasBothLines: mismatched.length > 0 && matched.length > 0, sameVerdict: mismatched === matched, mismatched, matched, output, log: logTail(homes) }).toMatchObject({
      hasBothLines: true,
      sameVerdict: false,
    });
  } finally {
    stub.stop();
  }
}, 30_000);
