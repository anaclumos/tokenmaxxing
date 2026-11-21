import { afterAll, expect, test } from "bun:test";
import { account, HOUR_MS } from "./fixtures.ts";
import { scratchDir, serve, useEnv, writePrivate } from "./edge-providers-fixtures.ts";

const GROK_ID = "4e1f0a7c-9b2d-4c3e-8f6a-0d5b7c1e2a94";
const nowWindow = Date.now();
const periodStart = nowWindow - 24 * HOUR_MS;
const periodEnd = nowWindow + 6 * 24 * HOUR_MS;

const stub = serve((req) => {
  if (req.headers.get("authorization") === "Bearer revoked-token") return Response.json({ error: "unauthorized" }, { status: 401 });
  if (req.headers.get("authorization") !== "Bearer grok-token") return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({
    config: {
      currentPeriod: { start: new Date(periodStart).toISOString(), end: new Date(periodEnd).toISOString() },
      creditUsagePercent: 37,
    },
  });
});

const restoreEnv = useEnv({
  HOME: scratchDir("home"),
  TOKENMAXXING_HOME: scratchDir("state"),
  GROK_HOME: undefined,
  TOKENMAXXING_GROK_USAGE_URL: `${stub.base}/v1/billing?format=credits`,
});
afterAll(() => {
  stub.stop();
  restoreEnv();
});

const { grokAuthJsonFor } = await import("../src/lib/paths.ts");
const { grok } = await import("../src/lib/grok.ts");

function writeStore(token: string): void {
  writePrivate(grokAuthJsonFor(GROK_ID), JSON.stringify({ [GROK_ID]: { user_id: GROK_ID, key: token, refresh_token: "grok-refresh" } }));
}

test("a grok sample lands the weekly credit window stamped with the sample clock", async () => {
  writeStore("grok-token");
  const sampledAt = Date.now() - 5_000;
  const sampled = account(GROK_ID, "supergrok", []);

  const reports = await grok.samplePool([sampled], sampledAt);

  expect({
    report: reports.get(GROK_ID),
    used: sampled.windows.map((w) => w.usedPercentage),
    stampedAtSample: sampled.windows.every((w) => w.sampledAt === sampledAt),
    lastUsageAt: sampled.lastUsageAt,
  }).toEqual({
    report: { ok: true, source: "probe" },
    used: [37],
    stampedAtSample: true,
    lastUsageAt: sampledAt,
  });
}, 20_000);

test("a grok sample whose stored token is refused flags the account for re-auth and lands no window", async () => {
  writeStore("revoked-token");
  const sampled = account(GROK_ID, "supergrok", []);

  const reports = await grok.samplePool([sampled], Date.now());
  const report = reports.get(GROK_ID);

  expect({
    ok: report?.ok,
    reasonHasStatus: report?.ok === false && report.reason.includes("HTTP 401"),
    needsReauth: sampled.needsReauth === true,
    lastUsageAt: sampled.lastUsageAt ?? null,
    windows: sampled.windows,
  }).toEqual({
    ok: false,
    reasonHasStatus: true,
    needsReauth: true,
    lastUsageAt: null,
    windows: [],
  });
}, 20_000);
