import { describe, expect, test } from "bun:test";
import { saveSessionFlags, loadSessionFlags } from "../src/lib/sessions.ts";

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
