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
  TOKENMAXXING_GROK_HOME: undefined,
  TOKENMAXXING_GROK_USAGE_URL: `${stub.base}/v1/billing?format=credits`,
});
afterAll(() => {
  stub.stop();
  restoreEnv();
});

const { grokAuthJsonFor, grokPool } = await import("../src/lib/paths.ts");
const { loadAccounts, saveAccounts } = await import("../src/lib/state.ts");
const { observeGrok } = await import("../src/lib/grok.ts");
const { ConfigSchema } = await import("../src/lib/types.ts");

function writeStore(token: string): void {
  writePrivate(grokAuthJsonFor(GROK_ID), JSON.stringify({ [GROK_ID]: { user_id: GROK_ID, key: token, refresh_token: "grok-refresh" } }));
}

test("a grok probe lands the weekly credit window stamped with the time of the read, not the caller's earlier clock", async () => {
  writeStore("grok-token");
  saveAccounts(grokPool, { version: 2, accounts: [account(GROK_ID, "supergrok", [])] });
  const [pooled] = loadAccounts(grokPool).accounts;
  if (!pooled) throw new Error("the grok pool lost its account");

  const before = Date.now();
  const observed = await observeGrok(pooled, ConfigSchema.parse({}), before - 5_000, { probe: true });
  const after = Date.now();

  const stored = loadAccounts(grokPool).accounts.find((a) => a.id === GROK_ID);
  const at = stored?.lastUsageAt ?? 0;
  expect({
    used: stored?.windows.map((w) => w.usedPercentage),
    stampedAtRead: stored?.windows.every((w) => w.sampledAt === at),
    readDuringCall: at >= before && at <= after,
    observedAt: observed?.at === at,
  }).toEqual({ used: [37], stampedAtRead: true, readDuringCall: true, observedAt: true });
}, 20_000);

test("a grok probe whose stored token is refused flags the account for re-auth and lands no window", async () => {
  writeStore("revoked-token");
  saveAccounts(grokPool, { version: 2, accounts: [account(GROK_ID, "supergrok", [])] });
  const [pooled] = loadAccounts(grokPool).accounts;
  if (!pooled) throw new Error("the grok pool lost its account");

  const observed = await observeGrok(pooled, ConfigSchema.parse({}), Date.now(), { probe: true });
  const stored = loadAccounts(grokPool).accounts.find((a) => a.id === GROK_ID);
  expect({ observed, needsReauth: stored?.needsReauth === true, lastUsageAt: stored?.lastUsageAt ?? null }).toEqual({
    observed: null,
    needsReauth: true,
    lastUsageAt: null,
  });
}, 20_000);
