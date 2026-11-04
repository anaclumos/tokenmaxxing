import { expect, test } from "bun:test";
import { answerOf, converse, endsTurn, timeline, turnStart } from "./codex-appserver-fixtures.ts";

test("a later turn on the same thread after a recovered overload runs under its own id, not the recovered turn's", async () => {
  const seen = await converse({
    script: ["overload", "answer"],
    windowMs: 60_000,
    steps: [
      { send: [turnStart(3, "Review the diff.")], until: endsTurn },
      { send: [turnStart(4, "Now fix it.")], until: endsTurn },
    ],
  });

  expect(seen.find((m) => m.id === 4)?.result).toMatchObject({ turn: { id: "turn-3" } });
  expect(timeline(seen)).toEqual(["turn/started turn-1 inProgress", "turn/completed turn-1 completed", "turn/started turn-3 inProgress", "turn/completed turn-3 completed"]);
  expect(answerOf(seen)).toMatchObject({ turnId: "turn-3", item: { text: JSON.stringify(["Review the diff.", "Continue.", "Now fix it."]) } });
}, 20_000);
