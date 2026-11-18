import { expect, test } from "bun:test";
import { join } from "node:path";
import { account } from "./fixtures.ts";
import { writeGrokStore, writePool } from "./edge-cli-surface-fixtures.ts";
import { seatsGrokArgs } from "../src/entries/groksupervisor.ts";
import { serve } from "./edge-providers-fixtures.ts";
import { supervise, supervisorSandbox, type Run } from "./edge-supervisor-fixtures.ts";

const GROK_ID = "4e1f0a7c-9b2d-4c3e-8f6a-0d5b7c1e2a94";

const childVar = (run: Run, name: string): string | null => run.launches[0]?.env[name] ?? null;

test("doctor seating treats interactive grok, agent, and dashboard as seated and help, version, and login as unsupervised", () => {
  expect({
    help: seatsGrokArgs(["--help"]),
    version: seatsGrokArgs(["--version"]),
    login: seatsGrokArgs(["login"]),
    agent: seatsGrokArgs(["agent", "stdio"]),
    dashboard: seatsGrokArgs(["dashboard"]),
    prompt: seatsGrokArgs(["-p", "list the files"]),
    bare: seatsGrokArgs([]),
  }).toEqual({
    help: false,
    version: false,
    login: false,
    agent: true,
    dashboard: true,
    prompt: true,
    bare: true,
  });
});

test("the grok supervisor seats -p, agent stdio, and an inherited GROK_HOME, and runs --version, login, TOKENMAXXING_UNMANAGED, TOKENMAXXING_PROBE, and XAI_API_KEY unsupervised", async () => {
  const s = supervisorSandbox();
  writePool(s, "grok", [account(GROK_ID, "supergrok", [])]);
  writeGrokStore(s, GROK_ID, "grok-refresh");
  const store = join(s.state, "grok-stores", GROK_ID.slice(0, 8));
  const stub = serve(() =>
    Response.json({
      config: {
        currentPeriod: { start: new Date(Date.now() - 86_400_000).toISOString(), end: new Date(Date.now() + 6 * 86_400_000).toISOString() },
        creditUsagePercent: 12,
      },
    }),
  );
  const usage = { TOKENMAXXING_GROK_USAGE_URL: `${stub.base}/v1/billing?format=credits` };
  try {
    const prompt = await supervise(s, "__supervise-grok", ["-p", "list the files"], usage);
    const agent = await supervise(s, "__supervise-grok", ["agent", "stdio"], usage);
    const inherited = await supervise(s, "__supervise-grok", ["-p", "list the files"], { ...usage, GROK_HOME: store });
    const version = await supervise(s, "__supervise-grok", ["--version"], usage);
    const login = await supervise(s, "__supervise-grok", ["login"], usage);
    const unmanaged = await supervise(s, "__supervise-grok", ["-p", "list the files"], { ...usage, TOKENMAXXING_UNMANAGED: "1" });
    const probe = await supervise(s, "__supervise-grok", ["-p", "list the files"], { ...usage, TOKENMAXXING_PROBE: "1" });
    const apiKey = await supervise(s, "__supervise-grok", ["-p", "list the files"], { ...usage, XAI_API_KEY: "xai-test" });
    const runs = [prompt, agent, inherited, version, login, unmanaged, probe, apiKey];

    expect({
      exits: runs.map((r) => r.exitCode),
      launches: runs.map((r) => r.launches.length),
      seatedHomes: [prompt, agent, inherited].map((r) => childVar(r, "GROK_HOME")),
      realHome: [prompt, agent, inherited].map((r) => childVar(r, "TOKENMAXXING_GROK_HOME")),
      unsupervisedHomes: [version, login, unmanaged, probe, apiKey].map((r) => childVar(r, "GROK_HOME")),
      stderr: runs.map((r) => r.stderr),
    }).toMatchObject({
      exits: [0, 0, 0, 0, 0, 0, 0, 0],
      launches: [1, 1, 1, 1, 1, 1, 1, 1],
      seatedHomes: [store, store, store],
      realHome: [join(s.home, ".grok"), join(s.home, ".grok"), join(s.home, ".grok")],
      unsupervisedHomes: [null, null, null, null, null],
    });
  } finally {
    stub.stop();
  }
}, 60_000);
