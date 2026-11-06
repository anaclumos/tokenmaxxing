import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { freshHome } from "./fixtures.ts";
import { IDS } from "./edge-minesweep-fixtures.ts";

const home = freshHome();
const LIVE = "5d2c7b9a-3e1f-4a6b-8c0d-9e7f1a3b5c06";
const KEYS = ["TOKENMAXXING_SUPERVISED", "TOKENMAXXING_SESSION_ID", "TOKENMAXXING_LAUNCHED_AT", "TOKENMAXXING_REFUSED", "TOKENMAXXING_API_KEY_ID"];
const saved = new Map(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("the supervised-session readers follow the environment of each call: session, launch time, live id, and refused accounts", async () => {
  const { refusedAccounts, supervisedSession } = await import("../src/lib/sessions.ts");
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", `${IDS.session}.json`), JSON.stringify({ flags: ["--model", "opus"], cwd: "/work/repo", current: LIVE }));
  const read = () => ({ session: supervisedSession(), refused: refusedAccounts() });

  Object.assign(process.env, { TOKENMAXXING_SUPERVISED: "1", TOKENMAXXING_SESSION_ID: IDS.session, TOKENMAXXING_LAUNCHED_AT: "1762400000000", TOKENMAXXING_REFUSED: `${IDS.spare},,${IDS.backup}`, TOKENMAXXING_API_KEY_ID: "" });
  const supervised = read();
  process.env.TOKENMAXXING_SESSION_ID = "";
  const noSid = read().session;
  for (const k of KEYS) delete process.env[k];
  const plain = read();

  expect({ supervised, noSid, plain }).toEqual({
    supervised: { session: { sid: IDS.session, launchedAt: 1762400000000, live: LIVE }, refused: [IDS.spare, IDS.backup] },
    noSid: null,
    plain: { session: null, refused: [] },
  });
});
