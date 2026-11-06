import { expect, test } from "bun:test";
import { freshHome } from "./fixtures.ts";
import { COMPACT_THREAD, compactWithFakeAppServer, logFields } from "./edge-minesweep-fixtures.ts";

const home = freshHome();
const CONTEXT_FULL = { message: "Your input exceeds the context window of this model." };

test("a failed Codex compaction logs the thread's own error notification, ignoring another thread's error and the failed turn that follows", async () => {
  await compactWithFakeAppServer([
    { method: "error", params: { threadId: "019a6b2e-0000-7000-8000-000000000999", turnId: "turn-9", willRetry: false, error: { message: "another thread failed" } } },
    { method: "error", params: { threadId: COMPACT_THREAD, turnId: "turn-1", willRetry: false, error: CONTEXT_FULL } },
    { method: "turn/completed", params: { threadId: COMPACT_THREAD, turn: { id: "turn-1", items: [], status: "failed", error: CONTEXT_FULL } } },
  ]);

  expect(logFields(home, "compact.codex")).toEqual([`thread=019a6b2e ok=false reason=app-server error: ${CONTEXT_FULL.message}`]);
}, 30_000);
