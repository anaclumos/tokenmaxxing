// cleanupThread: the finish_thread close-out. Threads run in the linked repo
// checkout (no per-thread worktree or branch since #14), so closing a thread
// is exactly dropping its record; the repo itself must never be touched.

import { describe, expect, test } from "bun:test";
import { cleanupThread } from "../src/lib/slackbridge.ts";
import { loadSlackThread, saveSlackThread } from "../src/lib/slackstate.ts";

describe("cleanupThread", () => {
  test("drops the thread record and reports the close-out", () => {
    const threadId = "slack:C0GCTEST:closeout";
    saveSlackThread({ threadId, repo: "/tmp/repo", cwd: "/tmp/repo", sessionId: "s-1", createdAt: new Date().toISOString() });
    const out = cleanupThread({ threadId });
    expect(out.removed).toBe(true);
    expect(loadSlackThread(threadId)).toBeNull();
    expect(out.message).toContain("fresh @mention");
  });

  test("a record-less thread still closes out idempotently", () => {
    const out = cleanupThread({ threadId: "slack:C0GCTEST:neverexisted" });
    expect(out.removed).toBe(true);
  });
});
