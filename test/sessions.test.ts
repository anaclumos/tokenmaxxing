import { describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { loadSessionFlags, pruneStaleSessions, saveSessionFlags } from "../src/lib/sessions.ts";
import { paths } from "../src/lib/paths.ts";

describe("session flag persistence (#23)", () => {
  test("round-trips the launch flags for a session id", () => {
    const sid = "aaaaaaaa-1111-2222-3333-444444444444";
    expect(loadSessionFlags(sid)).toBe(null);
    saveSessionFlags(sid, ["--dangerously-skip-permissions", "--model", "opus"], "/some/cwd");
    expect(loadSessionFlags(sid)).toEqual(["--dangerously-skip-permissions", "--model", "opus"]);
  });
  test("unknown session id returns null", () => {
    expect(loadSessionFlags("99999999-1111-2222-3333-444444444444")).toBe(null);
  });
});

describe("session file retention", () => {
  test("prunes files idle past 30 days, keeps fresh ones", () => {
    const staleSid = "bbbbbbbb-1111-2222-3333-444444444444";
    const freshSid = "cccccccc-1111-2222-3333-444444444444";
    saveSessionFlags(staleSid, ["--model", "opus"], "/some/cwd");
    saveSessionFlags(freshSid, [], "/some/cwd");
    const now = Date.now();
    const staleAge = new Date(now - 31 * 24 * 3600 * 1000);
    utimesSync(join(paths.home, "sessions", `${staleSid}.json`), staleAge, staleAge);
    pruneStaleSessions(now);
    expect(loadSessionFlags(staleSid)).toBe(null);
    expect(loadSessionFlags(freshSid)).toEqual([]);
  });
});
