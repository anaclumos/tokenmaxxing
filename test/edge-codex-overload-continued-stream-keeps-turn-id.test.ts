import { expect, test } from "bun:test";
import { z } from "zod";
import { type ClientMessage, converse, endsTurn, RATE_LIMITS_UPDATED, timeline, turnStart } from "./codex-appserver-fixtures.ts";

const TurnRefSchema = z.looseObject({ turnId: z.string().optional(), turn: z.looseObject({ id: z.string() }).optional() });
const turnIds = (m: ClientMessage): string[] => {
  const ref = TurnRefSchema.safeParse(m.params ?? m.result).data;
  return [ref?.turnId, ref?.turn?.id].filter((id) => id != null);
};

test("after an overload that omits willRetry, the continued turn's items, token usage, diff, and approval request reach the client under the failed turn's id, and the approval reaches the server", async () => {
  const seen = await converse({
    script: ["overloadUnflagged", "approval"],
    windowMs: 60_000,
    steps: [
      { send: [turnStart(3, "Run the tests.")], until: (since) => since.at(-1)?.method === "item/commandExecution/requestApproval" },
      { send: (prior) => [{ id: prior.at(-1)?.id, result: { decision: "accept" } }], until: endsTurn },
    ],
  });

  expect([...new Set(seen.flatMap(turnIds))]).toEqual(["turn-1"]);
  expect(seen.flatMap((m) => (m.method == null || m.method === RATE_LIMITS_UPDATED ? [] : [m.method]))).toEqual([
    "turn/started",
    "item/started",
    "item/agentMessage/delta",
    "thread/tokenUsage/updated",
    "turn/diff/updated",
    "item/commandExecution/requestApproval",
    "item/completed",
    "item/completed",
    "turn/completed",
  ]);
  expect(seen.find((m) => m.method === "item/completed")?.params).toMatchObject({ item: { type: "commandExecution", status: "completed" } });
  expect(timeline(seen).at(-1)).toBe("turn/completed turn-1 completed");
}, 20_000);
