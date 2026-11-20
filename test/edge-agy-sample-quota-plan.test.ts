import { afterAll, expect, test } from "bun:test";
import type { Account } from "../src/lib/types.ts";
import { account } from "./fixtures.ts";
import { agyIdentity, agyToken, quotaSummaryBody, serveAgyQuota, SESSION_S, WEEK_S } from "./edge-agy-fixtures.ts";
import { fakeBin, scratchDir, useEnv, writePrivate } from "./edge-providers-fixtures.ts";

const SUB = "google-sub-agy-1";
const AGY_ID = agyIdentity(SUB);
const now = Date.now();
const reset5h = new Date(now + SESSION_S * 1000).toISOString();
const resetWeekly = new Date(now + WEEK_S * 1000).toISOString();
const token = agyToken({ sub: SUB, email: "Dev@Example.com", access: "token-one", refresh: "refresh-one", expiry: new Date(now + 3600_000).toISOString() });

const stub = serveAgyQuota({
  summaryBodies: {
    "token-one": quotaSummaryBody(0.55, 0.8, reset5h, resetWeekly),
  },
});

const state = scratchDir("state");
const home = scratchDir("home");
const binDir = scratchDir("fake-agy-bin");
const agyBin = fakeBin(binDir, "agy", 'if [ "$1" = "--version" ]; then echo "1.5.12"; exit 0; fi\nexit 0');
const restoreEnv = useEnv({
  HOME: home,
  TOKENMAXXING_HOME: state,
  TOKENMAXXING_AGY_API_URL: stub.apiUrl,
  TOKENMAXXING_AGY_CLIENT_ID: "client.apps.googleusercontent.com",
  TOKENMAXXING_AGY_CLIENT_SECRET: "GOCSPX-test-secret-value12",
  TOKENMAXXING_AGY_BIN: agyBin,
  PATH: `${binDir}:${process.env.PATH ?? ""}`,
});
afterAll(() => {
  stub.stop();
  restoreEnv();
  delete process.env.TOKENMAXXING_AGY_BIN;
});

const { agyAuthJsonFor } = await import("../src/lib/paths.ts");
const { agy } = await import("../src/lib/agy.ts");

writePrivate(agyAuthJsonFor(AGY_ID), JSON.stringify(token, null, 2));

test("an Antigravity sample reads 5h and weekly quota from Code Assist and lands plan and email on the account", async () => {
  const sampled: Account = { ...account(AGY_ID, "free", []), email: null };

  const reports = await agy.samplePool([sampled], now);

  expect({
    report: reports.get(AGY_ID),
    tier: sampled.tier,
    email: sampled.email,
    windows: sampled.windows,
  }).toEqual({
    report: { ok: true, source: "probe" },
    tier: "pro",
    email: "dev@example.com",
    windows: [
      { name: null, usedPercentage: 45, resetsAt: Date.parse(reset5h), windowSeconds: SESSION_S, sampledAt: now },
      { name: "week", usedPercentage: 20, resetsAt: Date.parse(resetWeekly), windowSeconds: WEEK_S, sampledAt: now },
    ],
  });
}, 20_000);