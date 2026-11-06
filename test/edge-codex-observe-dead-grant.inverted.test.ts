import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import { account, HOUR_MS } from "./fixtures.ts";
import { codexAuthText, scratchDir, serve, useEnv, writePrivate } from "./edge-providers-fixtures.ts";

const DEAD_ID = "d3ad91a4-6c1e-4b55-9a1e-0c2f4e6a8b10";
const ROTATED_ID = "70a7ed52-8b3f-4e21-b6d4-5a9c3e1f7d28";
const RefreshBodySchema = z.looseObject({ refresh_token: z.string() });

const stub = serve(async (req) => {
  if (new URL(req.url).pathname !== "/oauth/token") return Response.json({ detail: "the usage endpoint is not part of this test" }, { status: 500 });
  const { refresh_token } = RefreshBodySchema.parse(await req.json());
  if (refresh_token === `rt-${ROTATED_ID}`) {
    writePrivate(codexAuthJsonFor(ROTATED_ID), codexAuthText({ accountId: ROTATED_ID, expiresAt: Date.now() + 10 * 24 * HOUR_MS, refreshToken: `rt2-${ROTATED_ID}`, tag: "rotated-elsewhere" }));
  }
  return Response.json({ error: "invalid_grant", error_description: "The refresh token has already been used." }, { status: 400 });
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
const { observeCodex } = await import("../src/lib/codex.ts");
const { ConfigSchema } = await import("../src/lib/types.ts");

test("inverted: a dead refresh grant marks the account for reauth only while its store still holds the token that refresh used", async () => {
  const now = Date.now();
  for (const id of [DEAD_ID, ROTATED_ID]) {
    writePrivate(codexAuthJsonFor(id), codexAuthText({ accountId: id, expiresAt: now - HOUR_MS, refreshToken: `rt-${id}`, tag: "expired" }));
  }
  saveAccounts(codexPool, { version: 2, accounts: [{ ...account(DEAD_ID, "pro", []), label: "dead" }, { ...account(ROTATED_ID, "pro", []), label: "rotated" }] });

  const cfg = ConfigSchema.parse({});
  for (const a of loadAccounts(codexPool).accounts) await observeCodex(a, cfg, now, { probe: true, refresh: true });

  const marks = Object.fromEntries(loadAccounts(codexPool).accounts.map((a) => [a.label, a.needsReauth === true]));
  expect(marks).not.toEqual({ dead: true, rotated: false });
}, 20_000);
