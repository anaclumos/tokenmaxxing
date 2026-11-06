import { expect, test } from "bun:test";
import { launchSummary, supervise, supervisorSandbox } from "./edge-supervisor-fixtures.ts";

const SESSION = "0190f5a2-7c3e-7b4d-9a1f-3e5c7d9b1a20";

test("claude --session-id <uuid> starts Claude Code on that session id as a new session and names it to the child", async () => {
  const s = supervisorSandbox();
  const run = await supervise(s, "__supervise", ["--session-id", SESSION, "fix the failing test"]);
  expect(launchSummary(run)).toMatchObject({
    exitCode: 0,
    launches: [{ argv: ["--session-id", SESSION, "fix the failing test"], sessionId: SESSION }],
  });
}, 30_000);
