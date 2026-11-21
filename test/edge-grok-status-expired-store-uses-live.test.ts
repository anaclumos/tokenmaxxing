import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { parseJson, preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { writePool } from "./edge-cli-surface-fixtures.ts";
import { scratchDir } from "./edge-providers-fixtures.ts";
import { fileTree, grokAuthText, grokEntry, grokEnv, grokReport, grokStore, pooledGrok, serveGrokCredits, storeGrokLogin, writeGrokAuth } from "./edge-grok-statusonly-fixtures.ts";

const EXPIRED = "c13462ed-16f3-4fae-9cd2-e3469f5b1e0c";
const OTHER = "c24573fe-27f4-4baf-9de3-f457a06c2f1e";
const HOUR_MS = 3_600_000;

test("status reads a grok account whose stored token has expired with the same account's login in GROK_HOME and leaves the store as it was", async () => {
  const homes = preparedHomes();
  const stale = grokEntry(EXPIRED, { email: "expired@example.com", key: "stale-token", refresh: "stale-refresh", expiresAt: Date.now() - HOUR_MS });
  const live = {
    [OTHER]: grokEntry(OTHER, { email: "other@example.com", key: "other-live-token" }),
    [EXPIRED]: grokEntry(EXPIRED, { email: "expired@example.com", key: "live-token", refresh: "live-refresh", expiresAt: Date.now() + HOUR_MS }),
  };
  const ambient = scratchDir("grok-home");
  writeGrokAuth(ambient, live);
  writePool(homes, "grok", [pooledGrok(EXPIRED, "expired@example.com")]);
  storeGrokLogin(homes, EXPIRED, stale);
  const stub = serveGrokCredits({ "live-token": { percent: 37 }, "other-live-token": { percent: 12 } });
  try {
    const result = await run(["status", "--json"], grokEnv(homes, stub, { GROK_HOME: ambient }));
    const report = grokReport(parseJson(result.stdout), EXPIRED);
    expect({
      exitCode: result.exitCode,
      report: report && { needsReauth: report.needsReauth, used: report.usage?.week?.usedPercentage, sample: report.sample },
      store: grokStore(homes, EXPIRED),
      ambient: fileTree(ambient),
      stderr: result.stderr,
    }).toEqual({
      exitCode: 0,
      report: { needsReauth: false, used: 37, sample: { ok: true, source: "probe" } },
      store: { doc: { [EXPIRED]: stale }, mode: 0o600 },
      ambient: { "auth.json": grokAuthText(live) },
      stderr: "",
    });
  } finally {
    stub.stop();
  }
}, 30_000);
