import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { parseJson, preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { writePool } from "./edge-cli-surface-fixtures.ts";
import { grokEntry, grokEnv, grokReport, pooledGrok, serveGrokCredits, storeGrokLogin, WEEK_S } from "./edge-grok-statusonly-fixtures.ts";

const HALF = "2d9a6e43-7c5f-4b0a-9e38-4fac9b5d1a62";
const FULL = "3eab7f54-8d6a-4c1b-8f49-5abd0c6e2b73";
const EMPTY = "4fbc8a65-9e7b-4d2c-9a5a-6bce1d7f3c84";

test("status --json reports each grok account with the weekly credit window in usage.week, bufferedPercentage equal to the provider figure, no sessions, exhausted at the weekly bar, and null usage while unmeasured", async () => {
  const homes = preparedHomes();
  writePool(homes, "grok", [pooledGrok(HALF, "half@example.com"), pooledGrok(FULL, "full@example.com"), pooledGrok(EMPTY, "empty@example.com")]);
  storeGrokLogin(homes, HALF, grokEntry(HALF, { key: "half-token" }));
  storeGrokLogin(homes, FULL, grokEntry(FULL, { key: "full-token" }));
  const stub = serveGrokCredits({ "half-token": { percent: 49 }, "full-token": { percent: 99 } });
  try {
    const result = await run(["status", "--json"], grokEnv(homes, stub));
    const doc = parseJson(result.stdout);
    const empty = grokReport(doc, EMPTY);
    const week = (usedPercentage: number, bufferedPercentage: number) => ({ fiveHour: null, week: { usedPercentage, bufferedPercentage, resetsAt: stub.periodEnd, windowSeconds: WEEK_S }, limits: [] });
    expect({
      exitCode: result.exitCode,
      ok: doc?.ok,
      half: grokReport(doc, HALF),
      full: grokReport(doc, FULL),
      empty: empty && { ...empty, sample: { ok: empty.sample.ok, pointsAtAuth: !empty.sample.ok && empty.sample.reason.includes("auth --grok") } },
      stderr: result.stderr,
    }).toEqual({
      exitCode: 0,
      ok: true,
      half: { active: false, sessions: 0, needsReauth: false, exhausted: false, usage: week(49, 49), sample: { ok: true, source: "probe" } },
      full: { active: false, sessions: 0, needsReauth: false, exhausted: true, usage: week(99, 99), sample: { ok: true, source: "probe" } },
      empty: { active: false, sessions: 0, needsReauth: false, exhausted: false, usage: null, sample: { ok: false, pointsAtAuth: true } },
      stderr: "",
    });
  } finally {
    stub.stop();
  }
}, 30_000);
