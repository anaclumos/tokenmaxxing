import { afterAll, expect, test } from "bun:test";
import { basename } from "node:path";
import { account, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";
import { answerText, drive, opening, replied, rpc, THREAD_ID, timeline, turnEnded } from "./edge-codex-shim-fixtures.ts";
import { codexAuthText, scratchDir, useEnv, writePrivate } from "./edge-providers-fixtures.ts";

const SPARE_ID = "b7e2c9a4-3d1f-4a6b-8e5c-2f9d0a7b4c63";
const state = scratchDir("state");
const restoreEnv = useEnv({
  HOME: scratchDir("home"),
  TOKENMAXXING_HOME: state,
  TOKENMAXXING_CODEX_HOME: scratchDir("codex-home"),
  CODEX_HOME: undefined,
  TOKENMAXXING_CODEX_SUPERVISOR_ID: undefined,
  TOKENMAXXING_CODEX_TOKEN_URL: "http://127.0.0.1:9/oauth/token",
  TOKENMAXXING_CODEX_USAGE_URL: "http://127.0.0.1:9/backend-api/wham/usage",
});
afterAll(restoreEnv);

const { codexAuthJsonFor, codexPool, codexStoreDirFor } = await import("../src/lib/paths.ts");
const { saveAccounts } = await import("../src/lib/state.ts");

test("an idle shim moves a refused turn onto another pooled account and the client sees that turn complete under its own id", async () => {
  const now = Date.now();
  const spare = { ...account(SPARE_ID, "pro", [sessionWindow(10, now + 2 * HOUR_MS, now), weeklyWindow(10, now + 4 * 24 * HOUR_MS, now)]), lastUsageAt: now };
  saveAccounts(codexPool, { version: 2, accounts: [spare] });
  writePrivate(codexAuthJsonFor(SPARE_ID), codexAuthText({ accountId: SPARE_ID, expiresAt: now + 10 * 24 * HOUR_MS, refreshToken: `rt-${SPARE_ID}`, tag: "spare" }));
  const firstStore = scratchDir("store");

  const seen = await drive({
    store: firstStore,
    seatId: "acct-test",
    env: { EDGE_REFUSE_HOME: firstStore },
    steps: [
      { send: opening(state), until: replied(2) },
      { send: [rpc({ id: 3, method: "turn/start", params: { threadId: THREAD_ID, input: [{ type: "text", text: "Review the diff." }] } })], until: turnEnded },
    ],
  });

  const firstTurn = `${basename(firstStore)}-turn-1`;
  expect({ timeline: timeline(seen), answeredFrom: answerText(seen) }).toEqual({
    timeline: [`turn/started ${firstTurn} inProgress`, `turn/completed ${firstTurn} completed`],
    answeredFrom: codexStoreDirFor(SPARE_ID),
  });
}, 30_000);
