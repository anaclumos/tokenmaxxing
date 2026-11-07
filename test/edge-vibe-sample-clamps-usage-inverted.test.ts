import { afterAll, expect, test } from "bun:test";
import type { Account } from "../src/lib/types.ts";
import { account } from "./fixtures.ts";
import { scratchDir, useEnv, writePrivate } from "./edge-providers-fixtures.ts";
import { budgetBody, DAY_S, serveMistral, vibeIdentity } from "./edge-vibe-fixtures.ts";

const now = Date.now();
const RESET_AT = new Date(now + 20 * DAY_S * 1000).toISOString();
const OVER_ID = vibeIdentity("user_over", "org_test");
const UNDER_ID = vibeIdentity("user_under", "org_test");

const stub = serveMistral({
  users: {
    "over-key": { id: "user_over", email: "over@example.com", organization: { id: "org_test" } },
    "under-key": { id: "user_under", email: "under@example.com", organization: { id: "org_test" } },
  },
  budgets: { "over-key": budgetBody(137.5, RESET_AT), "under-key": budgetBody(-3, RESET_AT) },
});

const restoreEnv = useEnv({
  HOME: scratchDir("home"),
  TOKENMAXXING_HOME: scratchDir("state"),
  TOKENMAXXING_VIBE_API_URL: stub.apiUrl,
});
afterAll(() => {
  stub.stop();
  restoreEnv();
});

const { vibeAuthJsonFor } = await import("../src/lib/paths.ts");
const { vibe } = await import("../src/lib/vibe.ts");

test("inverted: a Vibe sample lands a usage figure no clamp produces", async () => {
  writePrivate(vibeAuthJsonFor(OVER_ID), JSON.stringify({ id: OVER_ID, apiKey: "over-key" }));
  writePrivate(vibeAuthJsonFor(UNDER_ID), JSON.stringify({ id: UNDER_ID, apiKey: "under-key" }));
  const over: Account = account(OVER_ID, "pro", []);
  const under: Account = account(UNDER_ID, "pro", []);

  const reports = await vibe.samplePool([over, under], now);

  const month = { name: null, resetsAt: Date.parse(RESET_AT), windowSeconds: 30 * DAY_S, sampledAt: now };
  expect({ reports: [reports.get(OVER_ID), reports.get(UNDER_ID)], over: over.windows, under: under.windows }).toEqual({
    reports: [
      { ok: true, source: "probe" },
      { ok: true, source: "probe" },
    ],
    over: [{ ...month, usedPercentage: -1 }],
    under: [{ ...month, usedPercentage: 0 }],
  });
}, 20_000);
