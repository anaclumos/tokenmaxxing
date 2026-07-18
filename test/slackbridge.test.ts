// slackbridge: the detached claude child spawn and the finish_thread
// close-out. The daemon's drain can only preserve an in-flight turn if a
// group-directed signal (terminal Ctrl-C) does not reach the claude child, so
// the child must own its process group; closing a thread is exactly dropping
// its record (threads run in the linked repo checkout, no per-thread worktree
// or branch since #14), and the repo itself must never be touched.

import { describe, expect, test } from "bun:test";
import { cleanupThread, detachedClaudeSpawn } from "../src/lib/slackbridge.ts";
import { loadSlackThread, saveSlackThread } from "../src/lib/slackstate.ts";

function pgidOf(pid: number): number {
  const r = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]);
  return Number(new TextDecoder().decode(r.stdout).trim());
}

describe("detachedClaudeSpawn", () => {
  test("child leads its own process group, apart from the daemon's", () => {
    const child = detachedClaudeSpawn({
      command: "/bin/sleep",
      args: ["5"],
      env: {},
      signal: new AbortController().signal,
    });
    try {
      expect(child.pid).toBeDefined();
      const childPid = child.pid ?? 0;
      expect(pgidOf(childPid)).toBe(childPid);
      expect(pgidOf(childPid)).not.toBe(pgidOf(process.pid));
    } finally {
      child.kill("SIGTERM");
    }
  });

  test("stderr is ignored: the SDK's SpawnedProcess contract never reads it", async () => {
    const child = detachedClaudeSpawn({ command: "/usr/bin/true", args: [], env: {}, signal: new AbortController().signal });
    expect(child.stderr).toBeNull();
    const code = await new Promise((resolve) => {
      child.once("exit", (c) => resolve(c));
    });
    expect(code).toBe(0);
  });

  test("aborting the forwarded signal SIGTERMs the detached group", async () => {
    const ac = new AbortController();
    const child = detachedClaudeSpawn({ command: "/bin/sleep", args: ["30"], env: {}, signal: ac.signal });
    const exited = new Promise((resolve) => {
      child.once("exit", (_c, sig) => resolve(sig));
    });
    ac.abort();
    expect(await exited).toBe("SIGTERM");
  });

  test("an already-aborted signal kills the child instead of leaking it", async () => {
    const ac = new AbortController();
    ac.abort();
    const child = detachedClaudeSpawn({ command: "/bin/sleep", args: ["30"], env: {}, signal: ac.signal });
    const exited = new Promise((resolve) => {
      child.once("exit", (_c, sig) => resolve(sig));
    });
    expect(await exited).toBe("SIGTERM");
  });
});

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
