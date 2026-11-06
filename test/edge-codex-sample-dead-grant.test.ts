import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import { account, HOUR_MS } from "./fixtures.ts";
import { codexAuthText, scratchDir, serve, useEnv, writePrivate } from "./edge-providers-fixtures.ts";

const DEAD_ID = "5ad0c0de-2f4b-4c8e-9d1a-6b3e7f0a2c41";
const FLAKY_ID = "f1a4b0e5-7c2d-4e9f-8a3b-1d6c5e2f9a07";
const RefreshBodySchema = z.looseObject({ refresh_token: z.string() });

const stub = serve(async (req) => {
  if (new URL(req.url).pathname !== "/oauth/token") return Response.json({ detail: "the usage endpoint is not part of this test" }, { status: 500 });
  const { refresh_token } = RefreshBodySchema.parse(await req.json());
  if (refresh_token === `rt-${FLAKY_ID}`) return Response.json({ error: "temporarily_unavailable", error_description: "Try again shortly." }, { status: 503 });
  return Response.json({ error: "invalid_grant", error_description: "The refresh token has been revoked." }, { status: 400 });
});

const restoreEnv = useEnv({
  HOME: scratchDir("home"),
  TOKENMAXXING_HOME: scratchDir("state"),
  TOKENMAXXING_CODEX_HOME: scratchDir("codex-home"),
  CODEX_HOME: undefined,
  TOKENMAXXING_CODEX_SUPERVISOR_ID: undefined,
  TOKENMAXXING_CODEX_TOKEN_URL: `${stub.base}/oauth/token`,
  TOKENMAXXING_CODEX_USAGE_URL: `${stub.base}/backend-api/wham/usage`,
});
afterAll(() => {
  stub.stop();
  restoreEnv();
});

const { codexAuthJsonFor, codexPool } = await import("../src/lib/paths.ts");
const { loadAccounts, saveAccounts } = await import("../src/lib/state.ts");
const { codex } = await import("../src/lib/codex.ts");

test("status sampling marks a dead refresh grant for reauth and leaves an account whose refresh failed transiently unmarked", async () => {
  const now = Date.now();
  for (const id of [DEAD_ID, FLAKY_ID]) {
    writePrivate(codexAuthJsonFor(id), codexAuthText({ accountId: id, expiresAt: now - HOUR_MS, refreshToken: `rt-${id}`, tag: "expired" }));
  }
  saveAccounts(codexPool, { version: 2, accounts: [{ ...account(DEAD_ID, "pro", []), label: "dead" }, { ...account(FLAKY_ID, "pro", []), label: "flaky" }] });

  const reports = await codex.samplePool(loadAccounts(codexPool).accounts, now);

  const stored = loadAccounts(codexPool).accounts;
  expect({
    marks: Object.fromEntries(stored.map((a) => [a.label, a.needsReauth === true])),
    sampled: Object.fromEntries(stored.map((a) => [a.label, reports.get(a.id)?.ok])),
  }).toEqual({ marks: { dead: true, flaky: false }, sampled: { dead: false, flaky: false } });
}, 20_000);
