// slackbridge: the detached claude child spawn. The daemon's drain can only
// preserve an in-flight turn if a group-directed signal (terminal Ctrl-C)
// does not reach the claude child, so the child must own its process group.

import { describe, expect, test } from "bun:test";
import { detachedClaudeSpawn } from "../src/lib/slackbridge.ts";

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
});
