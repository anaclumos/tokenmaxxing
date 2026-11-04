import { expect, test } from "bun:test";
import { converse, interrupt, timeline, turnStart } from "./codex-appserver-fixtures.ts";

test("interrupting under the original id while the continued turn runs stops that turn, and the client sees it end as interrupted", async () => {
  const seen = await converse({
    script: ["overload", "hang"],
    windowMs: 60_000,
    steps: [
      { send: [turnStart(3, "Refactor the module.")], until: (since) => since.at(-1)?.method === "item/started" },
      { send: [interrupt(4, "turn-1")], until: (since) => since.some((m) => m.method === "turn/completed" || m.error != null) },
    ],
  });

  expect(seen.find((m) => m.id === 4)).toEqual({ id: 4, result: {} });
  expect(timeline(seen)).toEqual(["turn/started turn-1 inProgress", "turn/completed turn-1 interrupted"]);
}, 20_000);
