import { afterAll, expect, test } from "bun:test";
import type { Account } from "../src/lib/types.ts";
import { account } from "./fixtures.ts";
import { scratchDir, useEnv, writePrivate } from "./edge-providers-fixtures.ts";
import { DAY_S, serveMistral, vibeIdentity } from "./edge-vibe-fixtures.ts";

const now = Date.now();
const RESET_AT = new Date(now + 20 * DAY_S * 1000).toISOString();
const MISSING_ID = vibeIdentity("user_missing", "org_test");
const ZERO_ID = vibeIdentity("user_zero", "org_test");

const stub = serveMistral({
  users: {
    "missing-key": { id: "user_missing", email: "missing@example.com", organization: { id: "org_test" } },
    "zero-key": { id: "user_zero", email: "zero@example.com", organization: { id: "org_test" } },
  },
  budgets: {
    "missing-key": { api_budget: { usage_percentage: 40, initial_budget: 15, currency: "USD", reset_at: RESET_AT, payg_enabled: false } },
    "zero-key": { vibe_budget: { usage_percentage: 0, initial_budget: 0, currency: "USD", reset_at: RESET_AT, payg_enabled: false } },
  },
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

test("a Vibe sample whose budget has no vibe_budget, or a vibe_budget with no initial_budget, lands no allowance window and flags nothing", async () => {
  writePrivate(vibeAuthJsonFor(MISSING_ID), JSON.stringify({ id: MISSING_ID, apiKey: "missing-key" }));
  writePrivate(vibeAuthJsonFor(ZERO_ID), JSON.stringify({ id: ZERO_ID, apiKey: "zero-key" }));
  const missing: Account = account(MISSING_ID, "pro", []);
  const zero: Account = account(ZERO_ID, "pro", []);

  const reports = await vibe.samplePool([missing, zero], now);

  expect({
    missing: { windows: missing.windows, needsReauth: missing.needsReauth },
    zero: { windows: zero.windows, needsReauth: zero.needsReauth },
    reports: [reports.get(MISSING_ID), reports.get(ZERO_ID)],
  }).toMatchObject({
    missing: { windows: [], needsReauth: undefined },
    zero: { windows: [], needsReauth: undefined },
  });
}, 20_000);
