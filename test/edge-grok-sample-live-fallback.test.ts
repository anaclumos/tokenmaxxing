import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { account, HOUR_MS } from "./fixtures.ts";
import { scratchDir, serve, useEnv, writePrivate } from "./edge-providers-fixtures.ts";

const GROK_ID = "4e1f0a7c-9b2d-4c3e-8f6a-0d5b7c1e2a94";
const liveHome = scratchDir("grok-live");
const seatedHome = scratchDir("grok-seated");
const now = Date.now();
const periodStart = now - 24 * HOUR_MS;
const periodEnd = now + 6 * 24 * HOUR_MS;
const bearers: string[] = [];

const stub = serve((req) => {
  const bearer = req.headers.get("authorization") ?? "";
  bearers.push(bearer);
  if (bearer !== "Bearer live-token") return Response.json({ error: "unauthorized", error_description: "The access token was revoked." }, { status: 401 });
  return Response.json({ config: { currentPeriod: { start: new Date(periodStart).toISOString(), end: new Date(periodEnd).toISOString() }, creditUsagePercent: 37 } });
});

const restoreEnv = useEnv({
  HOME: scratchDir("home"),
  TOKENMAXXING_HOME: scratchDir("state"),
  GROK_HOME: liveHome,
  TOKENMAXXING_GROK_HOME: seatedHome,
  TOKENMAXXING_GROK_USAGE_URL: `${stub.base}/v1/billing?format=credits`,
});
afterAll(() => {
  stub.stop();
  restoreEnv();
});

const { grokAuthJsonFor } = await import("../src/lib/paths.ts");
const { grok, parkGrokEntry } = await import("../src/lib/grok.ts");

const OTHER_GROK_ID = "9b2d4c3e-8f6a-0d5b-7c1e2a944e1f";

test("a Grok sample whose stored token is refused retries with the live login and lands the credit window at the sample time", async () => {
  writePrivate(grokAuthJsonFor(GROK_ID), JSON.stringify({ [GROK_ID]: { user_id: GROK_ID, key: "store-token", refresh_token: "store-refresh", expires_at: new Date(now + 30 * 24 * HOUR_MS).toISOString() } }));
  writePrivate(join(liveHome, "auth.json"), JSON.stringify({ [GROK_ID]: { user_id: GROK_ID, key: "live-token", refresh_token: "live-refresh" } }));
  writePrivate(join(seatedHome, "auth.json"), JSON.stringify({ [GROK_ID]: { user_id: GROK_ID, key: "seated-token", refresh_token: "seated-refresh" } }));
  const sampled = account(GROK_ID, "supergrok", []);

  const reports = await grok.samplePool([sampled], now);

  const storeAuth = JSON.parse(readFileSync(grokAuthJsonFor(GROK_ID), "utf8")) as Record<string, { key?: string }>;

  expect({ report: reports.get(GROK_ID), windows: sampled.windows, lastUsageAt: sampled.lastUsageAt, bearers, storeKey: storeAuth[GROK_ID]?.key }).toEqual({
    report: { ok: true, source: "probe" },
    windows: [{ name: null, usedPercentage: 37, resetsAt: periodEnd, windowSeconds: Math.round((periodEnd - periodStart) / 1000), sampledAt: now }],
    lastUsageAt: now,
    bearers: ["Bearer store-token", "Bearer live-token"],
    storeKey: "live-token",
  });
}, 20_000);

test("parking a grok login writes the store and removes only that account from the ambient grok home", async () => {
  const livePath = join(liveHome, "auth.json");
  writePrivate(
    livePath,
    JSON.stringify({
      [GROK_ID]: { user_id: GROK_ID, key: "pooled-key", refresh_token: "pooled-refresh" },
      [OTHER_GROK_ID]: { user_id: OTHER_GROK_ID, key: "other-key", refresh_token: "other-refresh" },
    }),
  );

  await parkGrokEntry(GROK_ID, GROK_ID, { user_id: GROK_ID, key: "pooled-key", refresh_token: "pooled-refresh" });

  expect(JSON.parse(readFileSync(grokAuthJsonFor(GROK_ID), "utf8"))).toEqual({
    [GROK_ID]: { user_id: GROK_ID, key: "pooled-key", refresh_token: "pooled-refresh" },
  });
  expect(JSON.parse(readFileSync(livePath, "utf8"))).toEqual({
    [OTHER_GROK_ID]: { user_id: OTHER_GROK_ID, key: "other-key", refresh_token: "other-refresh" },
  });
});

test("parking the last grok login in the ambient home deletes auth.json there", async () => {
  const livePath = join(liveHome, "auth.json");
  writePrivate(livePath, JSON.stringify({ [GROK_ID]: { user_id: GROK_ID, key: "solo-key", refresh_token: "solo-refresh" } }));
  await parkGrokEntry(GROK_ID, GROK_ID, { user_id: GROK_ID, key: "solo-key", refresh_token: "solo-refresh" });
  expect(existsSync(livePath)).toBe(false);
});
