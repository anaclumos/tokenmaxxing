import { expect, test } from "bun:test";
import { launchSummary, supervise, supervisorSandbox, writeTranscript } from "./edge-supervisor-fixtures.ts";

const SESSION = "0190f5a2-4d6f-7a8b-8c1e-6b3d5f7a9c42";
const OTHER = "0190f5a2-2a4c-7e6d-9b8f-1c3e5a7d9f60";

test("inverted: claude --resume <uuid> resumes that session even when another session in the project is newer", async () => {
  const s = supervisorSandbox();
  const now = Date.now();
  writeTranscript(s, SESSION, now - 3_600_000);
  writeTranscript(s, OTHER, now - 60_000);
  const run = await supervise(s, "__supervise", ["--resume", SESSION]);
  expect(launchSummary(run)).not.toMatchObject({
    exitCode: 0,
    launches: [{ argv: ["--resume", SESSION], sessionId: SESSION }],
  });
}, 30_000);
