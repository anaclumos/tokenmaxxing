import { expect, test } from "bun:test";
import { supervise, supervisorSandbox } from "./edge-supervisor-fixtures.ts";

const SESSION = "0190f5a2-5e7a-7c1d-8f3b-6a8c0e2f4b17";
const CORRUPT_STOP = /tokenmaxxing: the session was stopped because the respawn marker is corrupt\./;

test("the supervisor never relaunches on a respawn marker that carries no launch time, and stops the session as on a corrupt marker", async () => {
  const marker = JSON.stringify({ accountId: "0190f5a2-0d2f-7a4b-8c6e-9f1b3d5a7c90", ts: Date.now(), waitUntil: 0, sessionId: SESSION, compact: false, origin: "stop" });
  const run = await supervise(supervisorSandbox(), "__supervise", ["--session-id", SESSION], { EDGE_MARKER_TEXT: marker, EDGE_EXIT: "0" });

  expect({ exitCode: run.exitCode, launches: run.launches.length, stopped: CORRUPT_STOP.test(run.stderr), stderr: run.stderr }).toMatchObject({
    exitCode: 1,
    launches: 1,
    stopped: true,
  });
}, 30_000);
