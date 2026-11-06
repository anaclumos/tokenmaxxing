import { expect, test } from "bun:test";
import { supervise, supervisorSandbox } from "./edge-supervisor-fixtures.ts";

const SESSION = "0190f5a2-6b8d-7f0a-9c2e-8e0a2c4e6b14";
const CORRUPT_STOP = /\x1b\[31mtokenmaxxing: the session was stopped because the respawn marker is corrupt\./;

test("a corrupt respawn marker stops the session with exit 1 and one tokenmaxxing: prefix that names the resume command", async () => {
  const s = supervisorSandbox();
  const run = await supervise(s, "__supervise", ["--session-id", SESSION], { EDGE_MARKER_TEXT: '{"accountId":', EDGE_EXIT: "0" });
  expect({
    exitCode: run.exitCode,
    launches: run.launches.length,
    stopped: CORRUPT_STOP.test(run.stderr),
    doubledPrefix: run.stderr.includes("tokenmaxxing: tokenmaxxing:"),
    namesResume: run.stderr.includes(`claude --resume ${SESSION}`),
    stderr: run.stderr,
  }).toMatchObject({ exitCode: 1, launches: 1, stopped: true, doubledPrefix: false, namesResume: true });
}, 30_000);
