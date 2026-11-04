import { expect, test } from "bun:test";
import { answerOf, converse, endsTurn, interrupt, RATE_LIMITS_UPDATED, timeline, turnStart } from "./codex-appserver-fixtures.ts";

test("interrupting while a second continuation waits delivers the overload as the turn's failure, and the next turn starts visibly under its own id", async () => {
  const seen = await converse({
    script: ["overload", "overload", "answer"],
    windowMs: 60_000,
    delaysMs: [5, 60_000],
    steps: [
      { send: [turnStart(3, "Review the diff.")], until: (since) => since.filter((m) => m.method === RATE_LIMITS_UPDATED).length === 2 },
      { send: [interrupt(4, "turn-1")], until: endsTurn },
      { send: [turnStart(5, "Try again.")], until: endsTurn },
    ],
  });

  expect(timeline(seen)).toEqual([
    "turn/started turn-1 inProgress",
    "error turn-1 serverOverloaded",
    "turn/completed turn-1 failed",
    "turn/started turn-3 inProgress",
    "turn/completed turn-3 completed",
  ]);
  expect(answerOf(seen)).toMatchObject({ turnId: "turn-3", item: { text: JSON.stringify(["Review the diff.", "Continue.", "Try again."]) } });
}, 20_000);
