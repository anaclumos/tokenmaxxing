import { expect, test } from "bun:test";
import { answerOf, converse, steer, timeline, turnStart } from "./codex-appserver-fixtures.ts";

test("steering the continued turn under the original id is accepted, and the steer reply and the rest of the turn name the original id", async () => {
  const seen = await converse({
    script: ["overload", "hang"],
    windowMs: 60_000,
    steps: [
      { send: [turnStart(3, "Refactor the module.")], until: (since) => since.at(-1)?.method === "item/started" },
      { send: [steer(4, "turn-1", "Keep the public API.")], until: (since) => since.some((m) => m.method === "turn/completed" || m.error != null) },
    ],
  });

  expect(seen.find((m) => m.id === 4)).toEqual({ id: 4, result: { turnId: "turn-1" } });
  expect(timeline(seen)).toEqual(["turn/started turn-1 inProgress", "turn/completed turn-1 completed"]);
  expect(answerOf(seen)).toMatchObject({ turnId: "turn-1", item: { text: JSON.stringify(["Refactor the module.", "Continue.", "Keep the public API."]) } });
}, 20_000);
