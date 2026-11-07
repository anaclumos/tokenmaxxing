import { afterAll, expect, test } from "bun:test";
import type { Account } from "../src/lib/types.ts";
import { account } from "./fixtures.ts";
import { scratchDir, serve, useEnv, writePrivate } from "./edge-providers-fixtures.ts";

const VIBE_ID = "d7e2a4c1-3f5b-4e8a-9c0d-1b2e3f4a5b6c";
const REVOKED_ID = "e8f3b5d2-4a6c-4f9b-8d1e-2c3f4a5b6c7d";
const RESET_AT = "2026-12-01T00:00:00Z";
const now = Date.now();
const calls: { path: string; bearer: string | null }[] = [];

const bodies: Record<string, unknown> = {
  "/mistral/v1/billing/budget": {
    vibe_budget: { usage_percentage: 12.5, initial_budget: 150, currency: "USD", reset_at: RESET_AT, payg_enabled: false },
    api_budget: { usage_percentage: 80, initial_budget: 15, currency: "USD", reset_at: RESET_AT, payg_enabled: false },
  },
  "/mistral/v1/billing/subscription": { plan_name: " PRO ", vibe_payg_enabled: false },
  "/mistral/v1/users/me": { id: "user_test", email: " Dev@Example.com ", organization: { id: "org_test", name: "Test Org" } },
};

const stub = serve((req) => {
  const path = new URL(req.url).pathname;
  const bearer = req.headers.get("authorization");
  calls.push({ path, bearer });
  if (bearer === "Bearer revoked-key") return Response.json({ detail: "Unauthorized" }, { status: 401 });
  const body = bodies[path];
  return body === undefined ? Response.json({ detail: "Not Found" }, { status: 404 }) : Response.json(body);
});

const restoreEnv = useEnv({
  HOME: scratchDir("home"),
  TOKENMAXXING_HOME: scratchDir("state"),
  TOKENMAXXING_VIBE_API_URL: `${stub.base}/mistral`,
});
afterAll(() => {
  stub.stop();
  restoreEnv();
});

const { vibeAuthJsonFor } = await import("../src/lib/paths.ts");
const { vibe } = await import("../src/lib/vibe.ts");

test("a Vibe sample lands the monthly Vibe allowance, plan, and email on its account, and a revoked key flags only its own account", async () => {
  writePrivate(vibeAuthJsonFor(VIBE_ID), JSON.stringify({ id: VIBE_ID, apiKey: "live-key" }));
  writePrivate(vibeAuthJsonFor(REVOKED_ID), JSON.stringify({ id: REVOKED_ID, apiKey: "revoked-key" }));
  const live: Account = { ...account(VIBE_ID, "free", []), email: null };
  const revoked: Account = { ...account(REVOKED_ID, "pro", []), lastUsageAt: now - 3_600_000 };
  const revokedWindows = revoked.windows;

  const reports = await vibe.samplePool([live, revoked], now);

  expect({
    live: { report: reports.get(VIBE_ID), tier: live.tier, email: live.email, windows: live.windows, needsReauth: live.needsReauth },
    revoked: { report: reports.get(REVOKED_ID), needsReauth: revoked.needsReauth, windows: revoked.windows, lastUsageAt: revoked.lastUsageAt },
    liveCalls: calls.filter((c) => c.bearer === "Bearer live-key").map((c) => c.path).toSorted(),
  }).toEqual({
    live: {
      report: { ok: true, source: "probe" },
      tier: "pro",
      email: "dev@example.com",
      windows: [{ name: null, usedPercentage: 12.5, resetsAt: Date.parse(RESET_AT), windowSeconds: 30 * 86400, sampledAt: now }],
      needsReauth: undefined,
    },
    revoked: {
      report: { ok: false, reason: "Mistral rejected the stored API key (HTTP 401) - run `tokenmaxxing auth --vibe`" },
      needsReauth: true,
      windows: revokedWindows,
      lastUsageAt: now - 3_600_000,
    },
    liveCalls: ["/mistral/v1/billing/budget", "/mistral/v1/billing/subscription", "/mistral/v1/users/me"],
  });
}, 20_000);
