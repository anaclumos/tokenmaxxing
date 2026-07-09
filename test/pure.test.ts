import { describe, expect, test } from "bun:test";
import { analyzeArgs, stripSessionFlags } from "../src/entries/supervisor.ts";
import { pickBest, isExhausted } from "../src/lib/picker.ts";
import { normalizeResetsAt, parseStatusLineStdin, parseStatusLineModel, parseUsageText, parseUsageTextFull, parseResetClock } from "../src/lib/usage.ts";
import type { Account } from "../src/lib/types.ts";

const UUID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

describe("supervisor argument analysis", () => {
  test("bare launch is managed", () => {
    expect(analyzeArgs([]).manage).toBe(true);
    expect(analyzeArgs(["--model", "opus"]).manage).toBe(true);
  });
  test("print mode is pass-through", () => {
    expect(analyzeArgs(["-p", "hello"]).manage).toBe(false);
    expect(analyzeArgs(["--print"]).manage).toBe(false);
  });
  test("non-interactive subcommands are pass-through", () => {
    expect(analyzeArgs(["mcp", "list"]).manage).toBe(false);
    expect(analyzeArgs(["--version"]).manage).toBe(false);
  });
  test("explicit session id / resume are captured", () => {
    expect(analyzeArgs(["--session-id", UUID]).sessionId).toBe(UUID);
    expect(analyzeArgs(["--resume", UUID]).resumeId).toBe(UUID);
    expect(analyzeArgs(["-r"]).resumeId).toBe(null); // picker mode, no id
    expect(analyzeArgs(["-c"]).continueLatest).toBe(true);
  });
  test("stripSessionFlags removes only session selectors", () => {
    expect(stripSessionFlags(["--session-id", UUID, "--model", "opus"])).toEqual(["--model", "opus"]);
    expect(stripSessionFlags(["--resume", UUID, "foo"])).toEqual(["foo"]);
    expect(stripSessionFlags(["-c", "--add-dir", "/x"])).toEqual(["--add-dir", "/x"]);
    expect(stripSessionFlags(["-r"])).toEqual([]); // bare -r (picker) also stripped
  });
});

function acct(over: Partial<Account>): Account {
  return {
    accountUuid: over.accountUuid ?? "uuid-" + Math.random(),
    email: over.email ?? "x@e.com",
    organizationUuid: "org",
    label: "l",
    keychainItem: "k",
    oauthAccount: { accountUuid: "a", emailAddress: "x@e.com", organizationUuid: "org" },
    addedAt: "now",
    ...over,
  };
}

describe("account picker", () => {
  const now = 1_000_000;
  test("prefers lowest 7-day usage, excludes current + reauth + exhausted", () => {
    const a = acct({ accountUuid: "A", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 50, resetsAt: null } } });
    const b = acct({ accountUuid: "B", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 20, resetsAt: null } } });
    const cur = acct({ accountUuid: "CUR" });
    const dead = acct({ accountUuid: "D", needsReauth: true });
    const best = pickBest([a, b, cur, dead], { now, threshold: 95, currentAccountUuid: "CUR" });
    expect(best?.accountUuid).toBe("B");
  });
  test("exhausted-until-reset excluded; available-after-reset included", () => {
    const blocked = acct({ accountUuid: "X", lastUsage: { fiveHour: { usedPercentage: 99, resetsAt: now + 10_000 }, sevenDay: { usedPercentage: 10, resetsAt: null } } });
    const reset = acct({ accountUuid: "Y", lastUsage: { fiveHour: { usedPercentage: 99, resetsAt: now - 10_000 }, sevenDay: { usedPercentage: 10, resetsAt: null } } });
    expect(isExhausted(blocked, { now, threshold: 95, currentAccountUuid: null })).toBe(true);
    expect(isExhausted(reset, { now, threshold: 95, currentAccountUuid: null })).toBe(false);
    expect(pickBest([blocked, reset], { now, threshold: 95, currentAccountUuid: null })?.accountUuid).toBe("Y");
  });
  test("no candidate returns null", () => {
    expect(pickBest([], { now, threshold: 95, currentAccountUuid: null })).toBe(null);
  });
});

describe("usage parsing", () => {
  test("normalizeResetsAt handles epoch seconds, ms, ISO", () => {
    expect(normalizeResetsAt(1738425600)).toBe(1738425600000);
    expect(normalizeResetsAt(1738425600000)).toBe(1738425600000);
    expect(normalizeResetsAt("2025-02-01T16:00:00Z")).toBe(Date.parse("2025-02-01T16:00:00Z"));
    expect(normalizeResetsAt(null)).toBe(null);
  });
  test("parseStatusLineStdin extracts both windows (epoch-seconds resets)", () => {
    const w = parseStatusLineStdin({ rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } } });
    expect(w?.fiveHour.usedPercentage).toBe(23.5);
    expect(w?.fiveHour.resetsAt).toBe(1738425600000);
    expect(w?.sevenDay.usedPercentage).toBe(41.2);
  });
  test("parseStatusLineStdin returns null when rate_limits absent", () => {
    expect(parseStatusLineStdin({ model: { id: "x" } })).toBe(null);
    expect(parseStatusLineStdin("garbage")).toBe(null);
  });
  test("parseUsageText best-effort", () => {
    const w = parseUsageText("Current session: 14% used · resets Jul 8. Current week (all models): 63% used");
    expect(w?.fiveHour.usedPercentage).toBe(14);
    expect(w?.sevenDay.usedPercentage).toBe(63);
  });
  test("parseStatusLineModel extracts the active model", () => {
    expect(parseStatusLineModel({ model: { id: "claude-fable-5", display_name: "Fable" } })).toEqual({ id: "claude-fable-5", display: "Fable" });
    expect(parseStatusLineModel({ foo: 1 })).toBe(null);
  });
  test("parseUsageTextFull separates session, week-all, and per-model caps with reset epochs", () => {
    const now = Date.parse("2026-07-09T12:00:00+09:00"); // Asia/Seoul reference
    const text = [
      "Current session: 35% used · resets Jul 9 at 11:20pm (Asia/Seoul)",
      "Current week (all models): 50% used · resets Jul 11 at 12pm (Asia/Seoul)",
      "Current week (Fable): 80% used · resets Jul 11 at 12pm (Asia/Seoul)",
    ].join("\n");
    const f = parseUsageTextFull(text, now)!;
    expect(f.session.usedPercentage).toBe(35);
    expect(f.session.resetsAt).toBe(Date.parse("2026-07-09T23:20:00+09:00"));
    expect(f.weekAll.usedPercentage).toBe(50);
    expect(f.weekAll.resetsAt).toBe(Date.parse("2026-07-11T12:00:00+09:00"));
    expect(f.perModel["Fable"]?.usedPercentage).toBe(80);
    expect(f.perModel["Fable"]?.resetsAt).toBe(Date.parse("2026-07-11T12:00:00+09:00"));
    expect(Object.keys(f.perModel)).toEqual(["Fable"]); // "all models" excluded
  });
  test("parseUsageTextFull tolerates missing reset clocks", () => {
    const f = parseUsageTextFull("Current session: 5% used", Date.parse("2026-07-09T12:00:00Z"))!;
    expect(f.session.usedPercentage).toBe(5);
    expect(f.session.resetsAt).toBe(null);
  });
  test("parseResetClock infers the nearest year and honors the tz", () => {
    const now = Date.parse("2026-12-31T12:00:00+09:00");
    // "Jan 1" with no year should resolve to 2027, not 2026 (nearest to now).
    expect(parseResetClock("Jan 1 at 9am (Asia/Seoul)", now)).toBe(Date.parse("2027-01-01T09:00:00+09:00"));
    expect(parseResetClock("nonsense", now)).toBe(null);
  });
});
