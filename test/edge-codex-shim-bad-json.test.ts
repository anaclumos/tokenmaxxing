import { afterAll, expect, test } from "bun:test";
import { drive, messages, objectOf, opening, replied, rpc } from "./edge-codex-shim-fixtures.ts";
import { scratchDir, useEnv } from "./edge-providers-fixtures.ts";

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

test("the app-server shim passes lines that are not JSON-RPC objects through unchanged in both directions and keeps the session answering", async () => {
  const seen = await drive({
    store: scratchDir("store"),
    seatId: "acct-test",
    env: { EDGE_NOISE: "1" },
    steps: [
      { send: opening(state), until: replied(2) },
      { send: ["not json {", "42", rpc({ id: 5, method: "thread/start", params: { cwd: state } })], until: replied(5) },
    ],
  });

  expect({
    fromServer: seen.filter((line) => objectOf(line) == null),
    fromClient: messages(seen).flatMap((m) => (m.method === "test/fromClient" ? [m.params?.line] : [])),
    replies: messages(seen).flatMap((m) => (m.method === undefined ? [m.id] : [])),
  }).toEqual({
    fromServer: ["fake-codex: warming up", "[1,2,3]"],
    fromClient: ["not json {", "42"],
    replies: [1, 2, 5],
  });
}, 30_000);
