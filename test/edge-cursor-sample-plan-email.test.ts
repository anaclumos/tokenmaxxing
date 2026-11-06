import { afterAll, expect, test } from "bun:test";
import type { Account } from "../src/lib/types.ts";
import { account, HOUR_MS } from "./fixtures.ts";
import { scratchDir, serve, useEnv, writePrivate } from "./edge-providers-fixtures.ts";

const CURSOR_ID = "c0a5d1e2-4b7f-4c8a-9e3d-2f1b6a0c5d78";
const SERVICE = "/cursor/aiserver.v1.DashboardService";
const now = Date.now();
const cycleStart = now - 10 * 24 * HOUR_MS;
const cycleEnd = now + 20 * 24 * HOUR_MS;
const calls: { path: string; bearer: string | null; connect: string | null }[] = [];

const bodies: Record<string, unknown> = {
  [`${SERVICE}/GetCurrentPeriodUsage`]: { billingCycleStart: String(cycleStart), billingCycleEnd: String(cycleEnd), planUsage: { totalPercentUsed: 33, apiPercentUsed: 12 } },
  [`${SERVICE}/GetPlanInfo`]: { planInfo: { planName: " Pro+ " } },
  [`${SERVICE}/GetMe`]: { email: " Dev@Example.com " },
};

const stub = serve((req) => {
  const path = new URL(req.url).pathname;
  calls.push({ path, bearer: req.headers.get("authorization"), connect: req.headers.get("connect-protocol-version") });
  const body = req.method === "POST" ? bodies[path] : undefined;
  return body === undefined ? Response.json({ code: "not_found" }, { status: 404 }) : Response.json(body);
});

const restoreEnv = useEnv({
  HOME: scratchDir("home"),
  TOKENMAXXING_HOME: scratchDir("state"),
  XDG_CONFIG_HOME: scratchDir("config"),
  TOKENMAXXING_CURSOR_API_URL: `${stub.base}/cursor`,
});
afterAll(() => {
  stub.stop();
  restoreEnv();
});

const { cursorAuthJsonFor } = await import("../src/lib/paths.ts");
const { cursor } = await import("../src/lib/cursor.ts");

test("a Cursor sample reads usage, plan, and email from the dashboard service and lands them on an account with no email yet", async () => {
  writePrivate(cursorAuthJsonFor(CURSOR_ID), JSON.stringify({ accessToken: "cursor-token" }));
  const sampled: Account = { ...account(CURSOR_ID, "free", []), email: null };

  const reports = await cursor.samplePool([sampled], now);

  const cycle = { resetsAt: cycleEnd, windowSeconds: Math.round((cycleEnd - cycleStart) / 1000), sampledAt: now };
  const sent = { bearer: "Bearer cursor-token", connect: "1" };
  expect({ report: reports.get(CURSOR_ID), tier: sampled.tier, email: sampled.email, windows: sampled.windows, calls: calls.toSorted((a, b) => a.path.localeCompare(b.path)) }).toEqual({
    report: { ok: true, source: "probe" },
    tier: "pro+",
    email: "dev@example.com",
    windows: [
      { name: null, usedPercentage: 33, ...cycle },
      { name: "API", usedPercentage: 12, ...cycle },
    ],
    calls: [
      { path: `${SERVICE}/GetCurrentPeriodUsage`, ...sent },
      { path: `${SERVICE}/GetMe`, ...sent },
      { path: `${SERVICE}/GetPlanInfo`, ...sent },
    ],
  });
}, 20_000);
