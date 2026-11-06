import { expect, test } from "bun:test";
import { launchSummary, supervise, supervisorSandbox, UUID, writeTranscript } from "./edge-supervisor-fixtures.ts";

const OLDER = "0190f5a2-9e1d-7c4a-b2e8-5f7a9c1d3e64";
const NEWER = "0190f5a2-1b3c-7d5e-8f60-2a4c6e8b0d17";

test("inverted: claude --continue resumes the project's most recently modified session, and starts a new session when the project has none", async () => {
  const withSessions = supervisorSandbox();
  const now = Date.now();
  writeTranscript(withSessions, NEWER, now - 60_000);
  writeTranscript(withSessions, OLDER, now - 2 * 3_600_000);
  const resumed = await supervise(withSessions, "__supervise", ["--continue"]);

  const empty = supervisorSandbox();
  const fresh = await supervise(empty, "__supervise", ["--continue"]);
  const started = fresh.launches[0];

  expect({
    resumed: launchSummary(resumed),
    fresh: {
      exitCode: fresh.exitCode,
      launches: fresh.launches.length,
      flag: started?.argv[0] ?? null,
      newId: UUID.test(started?.argv[1] ?? ""),
      childNamesSameId: started != null && started.env.TOKENMAXXING_SESSION_ID === started.argv[1],
      extraArgs: started?.argv.slice(2) ?? null,
      stderr: fresh.stderr,
    },
  }).not.toMatchObject({
    resumed: { exitCode: 0, launches: [{ argv: ["--resume", NEWER], sessionId: NEWER }] },
    fresh: { exitCode: 0, launches: 1, flag: "--session-id", newId: true, childNamesSameId: true, extraArgs: [] },
  });
}, 30_000);
