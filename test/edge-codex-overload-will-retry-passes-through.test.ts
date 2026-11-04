import { expect, test } from "bun:test";
import { answerOf, runTurnThroughProxy, THREAD_ID, timeline } from "./codex-appserver-fixtures.ts";

test("an overload that codex says it will retry reaches the client untouched, and the turn completes without a continuation", async () => {
  const seen = await runTurnThroughProxy({ script: ["retriedOverload"], windowMs: 60_000 });

  expect(seen.filter((m) => m.method === "error").map((m) => m.params)).toEqual([
    { threadId: THREAD_ID, turnId: "turn-1", willRetry: true, error: expect.objectContaining({ codexErrorInfo: "serverOverloaded" }) },
  ]);
  expect(timeline(seen)).toEqual(["turn/started turn-1 inProgress", "error turn-1 serverOverloaded", "turn/completed turn-1 completed"]);
  expect(answerOf(seen)).toMatchObject({ turnId: "turn-1", item: { text: JSON.stringify(["Review the diff."]) } });
}, 20_000);
