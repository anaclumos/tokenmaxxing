import { describe, expect, test } from "bun:test";
import { analyzeArgs, stripSessionFlags } from "../src/entries/supervisor.ts";
import { pickBest, isExhausted, weeklyExpiry } from "../src/lib/picker.ts";
import { familyTokens, matchedFamily, normalizeResetsAt, parseStatusLineStdin, parseStatusLineModel, parseUsageText, parseUsageTextFull, parseResetClock } from "../src/lib/usage.ts";
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
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  test("prefers soonest weekly expiry over most remaining, excludes current + reauth", () => {
    const soon = acct({ accountUuid: "A", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 80, resetsAt: now + 3_600_000 } } });
    const full = acct({ accountUuid: "B", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 20, resetsAt: now + 5 * 86_400_000 } } });
    const cur = acct({ accountUuid: "CUR" });
    const dead = acct({ accountUuid: "D", needsReauth: true });
    const best = pickBest([soon, full, cur, dead], { now, threshold: 95, currentAccountUuid: "CUR" });
    expect(best?.accountUuid).toBe("A");
  });
  test("tiebreaks equal expiry on lowest 7-day usage", () => {
    const a = acct({ accountUuid: "A", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 50, resetsAt: null } } });
    const b = acct({ accountUuid: "B", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 20, resetsAt: null } } });
    expect(pickBest([a, b], { now, threshold: 95, currentAccountUuid: null })?.accountUuid).toBe("B");
  });
  test("weeklyExpiry: future passes through, stale past extrapolates by weeks, unknown is Infinity", () => {
    const future = acct({ lastUsage: { fiveHour: { usedPercentage: 0, resetsAt: null }, sevenDay: { usedPercentage: 0, resetsAt: now + 5_000 } } });
    const stale = acct({ lastUsage: { fiveHour: { usedPercentage: 0, resetsAt: null }, sevenDay: { usedPercentage: 0, resetsAt: now - 10_000 } } });
    const veryStale = acct({ lastUsage: { fiveHour: { usedPercentage: 0, resetsAt: null }, sevenDay: { usedPercentage: 0, resetsAt: now - WEEK - 10_000 } } });
    expect(weeklyExpiry(future, now)).toBe(now + 5_000);
    expect(weeklyExpiry(stale, now)).toBe(now - 10_000 + WEEK);
    expect(weeklyExpiry(veryStale, now)).toBe(now - 10_000 + WEEK);
    expect(weeklyExpiry(acct({}), now)).toBe(Number.POSITIVE_INFINITY);
  });
  test("just-reset (stale past) account ranks after one with a known upcoming expiry", () => {
    const justReset = acct({ accountUuid: "R", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 90, resetsAt: now - 10_000 } } });
    const expiring = acct({ accountUuid: "E", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 30, resetsAt: now + 2 * 86_400_000 } } });
    expect(pickBest([justReset, expiring], { now, threshold: 95, currentAccountUuid: null })?.accountUuid).toBe("E");
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
  test("parseUsageTextFull parses the comma day-time glue (real 2.1.206 Linux output)", () => {
    const now = Date.parse("2026-07-10T13:00:00+09:00"); // Asia/Seoul reference
    const text = [
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 33% used · resets Jul 10, 3:30pm (Asia/Seoul)",
      "Current week (all models): 7% used · resets Jul 12, 10pm (Asia/Seoul)",
      "Current week (Fable): 0% used · resets Jul 12, 10pm (Asia/Seoul)",
    ].join("\n");
    const f = parseUsageTextFull(text, now)!;
    expect(f.session.usedPercentage).toBe(33);
    expect(f.session.resetsAt).toBe(Date.parse("2026-07-10T15:30:00+09:00"));
    expect(f.weekAll.usedPercentage).toBe(7);
    expect(f.weekAll.resetsAt).toBe(Date.parse("2026-07-12T22:00:00+09:00"));
    expect(f.perModel["Fable"]?.usedPercentage).toBe(0);
    expect(f.perModel["Fable"]?.resetsAt).toBe(Date.parse("2026-07-12T22:00:00+09:00"));
  });
  test("parseResetClock infers the nearest year and honors the tz", () => {
    const now = Date.parse("2026-12-31T12:00:00+09:00");
    // "Jan 1" with no year should resolve to 2027, not 2026 (nearest to now).
    expect(parseResetClock("Jan 1 at 9am (Asia/Seoul)", now)).toBe(Date.parse("2027-01-01T09:00:00+09:00"));
    expect(parseResetClock("nonsense", now)).toBe(null);
  });
  test("parseResetClock accepts exactly the observed day-time glues", () => {
    const now = Date.parse("2026-07-10T13:00:00+09:00");
    const expected = Date.parse("2026-07-10T15:30:00+09:00");
    expect(parseResetClock("Jul 10 at 3:30pm (Asia/Seoul)", now)).toBe(expected);
    expect(parseResetClock("Jul 10, 3:30pm (Asia/Seoul)", now)).toBe(expected);
    // An unobserved glue stays unparsed so format drift trips the drift log
    // instead of guessing an instant.
    expect(parseResetClock("Jul 10 3:30pm (Asia/Seoul)", now)).toBe(null);
  });
  test("parseUsageTextFull never lets a dateless clock steal the next entry's clock", () => {
    const now = Date.parse("2026-07-10T13:00:00+09:00");
    const f = parseUsageTextFull(
      "Current session: 14% used · resets Jul 8. Current week (all models): 63% used · resets Jul 12, 10pm (Asia/Seoul)",
      now,
    )!;
    expect(f.session.usedPercentage).toBe(14);
    expect(f.session.resetsAt).toBe(null);
    expect(f.weekAll.usedPercentage).toBe(63);
    expect(f.weekAll.resetsAt).toBe(Date.parse("2026-07-12T22:00:00+09:00"));
  });
});

describe("model family gate", () => {
  test("matchedFamily matches id or display tokens against switchModels", () => {
    expect(matchedFamily({ id: "claude-fable-5", display: "Fable 5" }, ["fable", "opus"])).toBe("fable");
    expect(matchedFamily({ id: "claude-opus-4-8", display: "Opus 4.8" }, ["fable", "opus"])).toBe("opus");
    expect(matchedFamily({ id: "claude-3-5-sonnet-20241022", display: "Sonnet" }, ["fable", "opus"])).toBe(null);
    expect(matchedFamily({ id: "", display: "Fable" }, ["fable", "opus"])).toBe("fable");
    expect(matchedFamily(null, ["fable"])).toBe(null);
  });
  test("familyTokens splits ids, versions, and display names", () => {
    expect(familyTokens("claude-opus-4-8")).toEqual(["claude", "opus", "4", "8"]);
    expect(familyTokens("Opus 4.8")).toEqual(["opus", "4", "8"]);
    expect(familyTokens("Fable 5")).toEqual(["fable", "5"]);
  });
});
