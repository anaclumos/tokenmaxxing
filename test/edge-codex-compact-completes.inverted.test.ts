import { expect, test } from "bun:test";
import { freshHome } from "./fixtures.ts";
import { COMPACT_THREAD, compactWithFakeAppServer, logFields } from "./edge-minesweep-fixtures.ts";

const home = freshHome();

test("inverted: compacting a Codex thread resumes it, starts compaction, and logs success once the compaction turn completes", async () => {
  const { requests } = await compactWithFakeAppServer([{ method: "turn/completed", params: { threadId: COMPACT_THREAD, turn: { id: "turn-1", items: [], status: "completed", error: null } } }]);

  expect({ requests, logged: logFields(home, "compact.codex") }).toEqual({
    requests: ["initialize", "initialized", "thread/resume", "thread/compact/start"],
    logged: ["thread=019a6b2e ok=false"],
  });
}, 30_000);
