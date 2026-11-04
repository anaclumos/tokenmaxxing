import { expect, test } from "bun:test";
import { answerOf, converse, endsTurn, THREAD_ID, timeline, turnStart } from "./codex-appserver-fixtures.ts";

test("a turn that fails with contextWindowExceeded reaches the client unchanged and is not continued", async () => {
  const seen = await converse({
    script: ["contextFull", "answer"],
    windowMs: 60_000,
    steps: [
      { send: [turnStart(3, "Review the diff.")], until: endsTurn },
      { send: [turnStart(4, "Summarize instead.")], until: endsTurn },
    ],
  });

  expect(seen.filter((m) => m.method === "error").map((m) => m.params)).toEqual([
    {
      threadId: THREAD_ID,
      turnId: "turn-1",
      willRetry: false,
      error: { message: "Your input exceeds the context window of this model.", codexErrorInfo: "contextWindowExceeded", additionalDetails: null },
    },
  ]);
  expect(timeline(seen)).toEqual([
    "turn/started turn-1 inProgress",
    "error turn-1 contextWindowExceeded",
    "turn/completed turn-1 failed",
    "turn/started turn-2 inProgress",
    "turn/completed turn-2 completed",
  ]);
  expect(answerOf(seen)).toMatchObject({ turnId: "turn-2", item: { text: JSON.stringify(["Review the diff.", "Summarize instead."]) } });
}, 20_000);
