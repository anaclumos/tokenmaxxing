import { expect, test } from "bun:test";
import { supervise, supervisorSandbox } from "./edge-supervisor-fixtures.ts";

const SUPERVISOR_VARS = {
  TOKENMAXXING_SUPERVISED: "1",
  TOKENMAXXING_SESSION_ID: "0190f5a2-5e7a-7b9c-8d2f-4a6c8e0b2d31",
  TOKENMAXXING_LAUNCHED_AT: "1793952000000",
  TOKENMAXXING_MODEL: "opus",
  TOKENMAXXING_REFUSED: "0190f5a2-6f8b-7c0d-9e3a-5b7d9f1c3e42",
  TOKENMAXXING_API_KEY_ID: "edge-key",
};

test("claude -p run from inside a supervised session reaches Claude Code without any of the outer session's supervisor variables", async () => {
  const s = supervisorSandbox();
  const run = await supervise(s, "__supervise", ["-p", "summarize the diff"], { ...SUPERVISOR_VARS, EDGE_CALLER_VAR: "kept" });
  const env = run.launches[0]?.env ?? {};
  expect({
    exitCode: run.exitCode,
    argv: run.launches.map((l) => l.argv),
    leaked: Object.keys(SUPERVISOR_VARS).filter((name) => name in env),
    callerVar: env.EDGE_CALLER_VAR ?? null,
    stderr: run.stderr,
  }).toMatchObject({
    exitCode: 0,
    argv: [["-p", "summarize the diff"]],
    leaked: [],
    callerVar: "kept",
  });
}, 30_000);
