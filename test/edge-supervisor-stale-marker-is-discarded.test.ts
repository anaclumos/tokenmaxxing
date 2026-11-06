import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHILD_LAUNCH, supervise, supervisorSandbox } from "./edge-supervisor-fixtures.ts";

const SESSION = "0190f5a2-8a0c-7e2f-a4b6-7d9f1b3e5a83";
const MOVED_TO = "0190f5a2-3c5e-7f7a-b9d1-0e2a4c6f8b25";

function marker(launchedAt: number | typeof CHILD_LAUNCH): string {
  return JSON.stringify({ accountId: "0190f5a2-0d2f-7a4b-8c6e-9f1b3d5a7c90", ts: Date.now(), waitUntil: 0, sessionId: MOVED_TO, compact: false, origin: "stop", launchedAt });
}

test("a respawn marker left for an earlier launch of the session is discarded, so the session ends with Claude Code's own exit code instead of moving", async () => {
  const stale = supervisorSandbox();
  const staleRun = await supervise(stale, "__supervise", ["--session-id", SESSION], { EDGE_MARKER_TEXT: marker(1), EDGE_EXIT: "7" });

  const current = supervisorSandbox();
  const currentRun = await supervise(current, "__supervise", ["--session-id", SESSION], { EDGE_MARKER_TEXT: marker(CHILD_LAUNCH), EDGE_EXIT: "7" });

  expect({
    stale: {
      exitCode: staleRun.exitCode,
      launches: staleRun.launches.map((l) => l.argv),
      markerLeft: existsSync(join(stale.state, "respawn", SESSION)),
      stderr: staleRun.stderr,
    },
    current: { launches: currentRun.launches.map((l) => l.argv), stderr: currentRun.stderr },
  }).toMatchObject({
    stale: { exitCode: 7, launches: [["--session-id", SESSION]], markerLeft: false },
    current: { launches: [["--session-id", SESSION], ["--session-id", MOVED_TO]] },
  });
}, 30_000);
