import { expect, test } from "bun:test";
import { answerOf, converse, RATE_LIMITS_UPDATED, timeline, turnStart } from "./codex-appserver-fixtures.ts";

test("a new turn/start while a continuation waits delivers the overload as the old turn's failure before the new turn starts", async () => {
  const seen = await converse({
    script: ["overload", "answer"],
    windowMs: 60_000,
    delaysMs: [60_000, 60_000],
    steps: [
      { send: [turnStart(3, "Review the diff.")], until: (since) => since.at(-1)?.method === RATE_LIMITS_UPDATED },
      { send: [turnStart(4, "Use a smaller change.")], until: (since) => since.filter((m) => m.method === "turn/completed").length === 2 },
    ],
  });

  expect(timeline(seen)).toEqual([
    "turn/started turn-1 inProgress",
    "error turn-1 serverOverloaded",
    "turn/completed turn-1 failed",
    "turn/started turn-2 inProgress",
    "turn/completed turn-2 completed",
  ]);
  expect(answerOf(seen)).toMatchObject({ turnId: "turn-2", item: { text: JSON.stringify(["Review the diff.", "Use a smaller change."]) } });
}, 20_000);
