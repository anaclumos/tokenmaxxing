import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { scratchDir, useEnv } from "./edge-providers-fixtures.ts";

const restoreEnv = useEnv({ HOME: scratchDir("home"), TOKENMAXXING_HOME: scratchDir("state") });
afterAll(restoreEnv);

const { admitResume } = await import("../src/lib/resumegate.ts");

const CAP = 100;

test("moved sessions resume in batches of eight, oldest move first, at most one batch per 15 seconds, and none while the load is at the cap", () => {
  const sids = Array.from({ length: 10 }, (_, i) => `session-${i}`);
  const ask = (sid: string, now: number, load: number) => admitResume({ sid, requestedAt: 1_000 - sids.indexOf(sid), loadCap: CAP, now, load });

  const atCap = sids.map((sid) => ask(sid, 20_000, CAP));
  const firstBatch = sids.filter((sid) => ask(sid, 20_000, CAP - 1));
  const beforeGap = ["session-0", "session-1"].map((sid) => ask(sid, 34_999, 0));
  const gapAtCap = ask("session-0", 35_000, CAP);
  const secondBatch = ["session-0", "session-1"].map((sid) => ask(sid, 35_000, CAP - 1));

  expect({ atCap, firstBatch, beforeGap, gapAtCap, secondBatch }).toEqual({
    atCap: sids.map(() => false),
    firstBatch: sids.slice(2),
    beforeGap: [false, false],
    gapAtCap: false,
    secondBatch: [true, true],
  });
});

test("a session whose supervisor is gone takes no place in a batch", () => {
  const gate = join(import.meta.dir, "../src/lib/resumegate.ts");
  const gone = Bun.spawnSync([process.execPath, "-e", `import(${JSON.stringify(gate)}).then(({ admitResume }) => admitResume({ sid: "gone", requestedAt: 0, loadCap: ${CAP}, now: 100000, load: ${CAP} }));`], { env: process.env });
  const live = Array.from({ length: 8 }, (_, i) => `live-${i}`);
  const ask = (sid: string, load: number) => admitResume({ sid, requestedAt: 1 + live.indexOf(sid), loadCap: CAP, now: 120_000, load });

  live.forEach((sid) => ask(sid, CAP));
  const admitted = live.map((sid) => ask(sid, 0));

  expect({ goneExit: gone.exitCode, admitted }).toEqual({ goneExit: 0, admitted: live.map(() => true) });
});
