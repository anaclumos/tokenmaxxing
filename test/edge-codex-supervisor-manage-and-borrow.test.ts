import { expect, test } from "bun:test";
import { join } from "node:path";
import { startStub, writeCodexPool, writeCodexStore } from "./edge-async-sweep-fixtures.ts";
import { account } from "./fixtures.ts";
import { supervise, supervisorSandbox, UUID, type Run } from "./edge-supervisor-fixtures.ts";

const CODEX_ID = "0190f5a2-4f6b-7d8e-9a0c-2e4a6c8f0b37";
const PARENT = { TOKENMAXXING_CODEX_SUPERVISOR_ID: "0190f5a2-7a9c-7e1f-8b3d-5f7b9d1a3c58" };

const childVar = (run: Run, name: string): string | null => run.launches[0]?.env[name] ?? null;

test("the codex supervisor supervises an interactive launch, runs --version, TOKENMAXXING_UNMANAGED, and TOKENMAXXING_PROBE launches unsupervised, and lends codex exec a pooled CODEX_HOME only when the caller set none and is no probe", async () => {
  const s = supervisorSandbox();
  const interactive = await supervise(s, "__supervise-codex", [], PARENT);
  const version = await supervise(s, "__supervise-codex", ["--version"], PARENT);
  const unmanaged = await supervise(s, "__supervise-codex", [], { ...PARENT, TOKENMAXXING_UNMANAGED: "1" });
  const probe = await supervise(s, "__supervise-codex", [], { ...PARENT, TOKENMAXXING_PROBE: "1" });

  writeCodexPool(s, [account(CODEX_ID, "pro", [])]);
  writeCodexStore(s, CODEX_ID);
  const callerHome = join(s.home, "caller-codex");
  const stub = startStub({ gated: [] });
  try {
    const usage = {
      TOKENMAXXING_CODEX_USAGE_URL: `${stub.base}/backend-api/wham/usage`,
      TOKENMAXXING_CODEX_RESET_URL: `${stub.base}/backend-api/wham/rate-limit-reset-credits/consume`,
    };
    const borrowed = await supervise(s, "__supervise-codex", ["exec", "list the files"], usage);
    const ownHome = await supervise(s, "__supervise-codex", ["exec", "list the files"], { ...usage, CODEX_HOME: callerHome });
    const probed = await supervise(s, "__supervise-codex", ["exec", "list the files"], { ...usage, TOKENMAXXING_PROBE: "1" });
    const runs = [interactive, version, unmanaged, probe, borrowed, ownHome, probed];

    expect({
      exits: runs.map((r) => r.exitCode),
      launches: runs.map((r) => r.launches.length),
      supervisedId: UUID.test(childVar(interactive, "TOKENMAXXING_CODEX_SUPERVISOR_ID") ?? "") && childVar(interactive, "TOKENMAXXING_CODEX_SUPERVISOR_ID") !== PARENT.TOKENMAXXING_CODEX_SUPERVISOR_ID,
      unsupervisedIds: [version, unmanaged, probe].map((r) => childVar(r, "TOKENMAXXING_CODEX_SUPERVISOR_ID")),
      execHomes: [borrowed, ownHome, probed].map((r) => childVar(r, "CODEX_HOME")),
      stderr: runs.map((r) => r.stderr),
    }).toMatchObject({
      exits: [0, 0, 0, 0, 0, 0, 0],
      launches: [1, 1, 1, 1, 1, 1, 1],
      supervisedId: true,
      unsupervisedIds: [null, null, null],
      execHomes: [join(s.state, "codex-stores", CODEX_ID.slice(0, 8)), callerHome, null],
    });
  } finally {
    stub.stop();
  }
}, 60_000);
