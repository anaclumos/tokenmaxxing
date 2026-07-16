import { describe, expect, test } from "bun:test";
import { analyzeArgs, stripSessionFlags } from "../src/entries/supervisor.ts";
import { currentWins, pacePressure, pickBest, isExhausted, nextWeeklyReset, pickEarliestReset, usableAt, weeklyExpiry } from "../src/lib/picker.ts";
import { familyTokens, gatedFamilies, matchedFamily, normalizeResetsAt, parseStatusLineStdin, parseStatusLineModel, parseUsageText, parseUsageTextFull, parseResetClock } from "../src/lib/usage.ts";
import { fmtAgo } from "../src/cli/render.ts";
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
  // Both bars at 95: these cases exercise window/reset semantics, not the split.
  const T = { session: 95, weekly: 95 };
  test("prefers the account furthest behind its own pace, excludes current + reauth", () => {
    // soonest expiry but nearly drained (10 left / 1d = 10/d) loses to the one
    // with real forfeiture pressure (80 left / 2d = 40/d) - the case where the
    // old soonest-expiry policy and pace pressure disagree.
    const soon = acct({ accountUuid: "A", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 90, resetsAt: now + 86_400_000 } } });
    const behind = acct({ accountUuid: "B", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 20, resetsAt: now + 2 * 86_400_000 } } });
    const cur = acct({ accountUuid: "CUR" });
    const dead = acct({ accountUuid: "D", needsReauth: true });
    const best = pickBest([soon, behind, cur, dead], { now, thresholds: T, currentAccountUuid: "CUR", switchFamilies: [] });
    expect(best?.accountUuid).toBe("B");
  });
  test("equal remaining reduces to soonest expiry first", () => {
    const near = acct({ accountUuid: "N", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 50, resetsAt: now + 86_400_000 } } });
    const far = acct({ accountUuid: "F", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 50, resetsAt: now + 4 * 86_400_000 } } });
    expect(pickBest([far, near], { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] })?.accountUuid).toBe("N");
  });
  test("pacePressure: rolled-over week counts as fresh, unknown anchor is 0", () => {
    const D = 86_400_000;
    const live = acct({ lastUsage: { fiveHour: { usedPercentage: 0, resetsAt: null }, sevenDay: { usedPercentage: 60, resetsAt: now + 2 * D } } });
    expect(pacePressure(live, now)).toBe(40 / (2 * D));
    // cached window already reset: the account is fresh again, deadline extrapolated
    const rolled = acct({ lastUsage: { fiveHour: { usedPercentage: 0, resetsAt: null }, sevenDay: { usedPercentage: 90, resetsAt: now - 10_000 } } });
    expect(pacePressure(rolled, now)).toBe(100 / (WEEK - 10_000));
    // no reset anchor: nothing is known to be forfeited on any clock
    expect(pacePressure(acct({}), now)).toBe(0);
    const clockless = acct({ lastUsage: { fiveHour: { usedPercentage: 0, resetsAt: null }, sevenDay: { usedPercentage: 30, resetsAt: null } } });
    expect(pacePressure(clockless, now)).toBe(0);
  });
  test("tiebreaks unknown-anchor (zero-pressure) accounts on lowest 7-day usage", () => {
    const a = acct({ accountUuid: "A", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 50, resetsAt: null } } });
    const b = acct({ accountUuid: "B", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 20, resetsAt: null } } });
    expect(pickBest([a, b], { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] })?.accountUuid).toBe("B");
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
  test("just-reset (stale past) account ranks after one with nearer forfeiture pressure", () => {
    // R is fresh with a full week ahead (100/7d); E must burn 70 in 2d.
    const justReset = acct({ accountUuid: "R", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 90, resetsAt: now - 10_000 } } });
    const expiring = acct({ accountUuid: "E", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 30, resetsAt: now + 2 * 86_400_000 } } });
    expect(pickBest([justReset, expiring], { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] })?.accountUuid).toBe("E");
  });
  test("exhausted-until-reset excluded; available-after-reset included", () => {
    const blocked = acct({ accountUuid: "X", lastUsage: { fiveHour: { usedPercentage: 99, resetsAt: now + 10_000 }, sevenDay: { usedPercentage: 10, resetsAt: null } } });
    const reset = acct({ accountUuid: "Y", lastUsage: { fiveHour: { usedPercentage: 99, resetsAt: now - 10_000 }, sevenDay: { usedPercentage: 10, resetsAt: null } } });
    expect(isExhausted(blocked, { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] })).toBe(true);
    expect(isExhausted(reset, { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] })).toBe(false);
    expect(pickBest([blocked, reset], { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] })?.accountUuid).toBe("Y");
  });
  test("no candidate returns null", () => {
    expect(pickBest([], { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] })).toBe(null);
  });
  test("nextWeeklyReset: future/null pass through, past extrapolates forward in 7-day steps", () => {
    expect(nextWeeklyReset(null, now)).toBe(null);
    expect(nextWeeklyReset(now + 5_000, now)).toBe(now + 5_000);
    expect(nextWeeklyReset(now - 10_000, now)).toBe(now - 10_000 + WEEK);
    expect(nextWeeklyReset(now - WEEK - 10_000, now)).toBe(now - 10_000 + WEEK);
  });
  test("null currentAccountUuid ranks every account, including the active one", () => {
    const cur = acct({ accountUuid: "CUR", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 60, resetsAt: now + 86_400_000 } } });
    const other = acct({ accountUuid: "O", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 10, resetsAt: now + 4 * 86_400_000 } } });
    expect(pickBest([cur, other], { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] })?.accountUuid).toBe("CUR");
    expect(pickBest([cur, other], { now, thresholds: T, currentAccountUuid: "CUR", switchFamilies: [] })?.accountUuid).toBe("O");
  });
  test("a session window over threshold disqualifies even the soonest weekly expiry", () => {
    const busy = acct({ accountUuid: "S", lastUsage: { fiveHour: { usedPercentage: 96, resetsAt: now + 3_600_000 }, sevenDay: { usedPercentage: 10, resetsAt: now + 86_400_000 } } });
    const idle = acct({ accountUuid: "I", lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 10, resetsAt: now + 3 * 86_400_000 } } });
    expect(pickBest([busy, idle], { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] })?.accountUuid).toBe("I");
  });
  test("a burnt gated per-model cap exhausts; other families and passed resets do not", () => {
    const fableBurnt = acct({
      accountUuid: "F",
      lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 40, resetsAt: now + 86_400_000 } },
      lastPerModel: { Fable: { usedPercentage: 96, resetsAt: now + 2 * 86_400_000 } },
    });
    expect(isExhausted(fableBurnt, { now, thresholds: T, currentAccountUuid: null, switchFamilies: ["fable"] })).toBe(true);
    expect(isExhausted(fableBurnt, { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] })).toBe(false);
    expect(isExhausted(fableBurnt, { now, thresholds: T, currentAccountUuid: null, switchFamilies: ["sonnet"] })).toBe(false);
    const resetSince = acct({
      accountUuid: "R",
      lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 40, resetsAt: now + 86_400_000 } },
      lastPerModel: { Fable: { usedPercentage: 96, resetsAt: now - 10_000 } },
    });
    expect(isExhausted(resetSince, { now, thresholds: T, currentAccountUuid: null, switchFamilies: ["fable"] })).toBe(false);
  });
  test("pickBest skips a fable-burnt candidate only when the fable family gates", () => {
    const soonButBurnt = acct({
      accountUuid: "B",
      lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 50, resetsAt: now + 86_400_000 } },
      lastPerModel: { "Fable 5": { usedPercentage: 97, resetsAt: now + 86_400_000 } },
    });
    const laterButClean = acct({
      accountUuid: "C",
      lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 20, resetsAt: now + 4 * 86_400_000 } },
      lastPerModel: { "Fable 5": { usedPercentage: 10, resetsAt: now + 4 * 86_400_000 } },
    });
    expect(pickBest([soonButBurnt, laterButClean], { now, thresholds: T, currentAccountUuid: null, switchFamilies: ["fable"] })?.accountUuid).toBe("C");
    expect(pickBest([soonButBurnt, laterButClean], { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] })?.accountUuid).toBe("B");
  });
  test("usableAt waits for a burnt gated cap's reset", () => {
    const a = acct({
      lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 10, resetsAt: now + 86_400_000 } },
      lastPerModel: { Fable: { usedPercentage: 96, resetsAt: now + 3 * 86_400_000 } },
    });
    expect(usableAt(a, { now, thresholds: T, currentAccountUuid: null, switchFamilies: ["fable"] })).toBe(now + 3 * 86_400_000);
    expect(usableAt(a, { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] })).toBe(now);
  });
  test("currentWins: seat kept on best or tie, lost to a strictly better usable account or own exhaustion", () => {
    const D = 86_400_000;
    const mk = (uuid: string, used: number) =>
      acct({ accountUuid: uuid, lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: used, resetsAt: now + 2 * D } } });
    const ctx = { now, thresholds: T, currentAccountUuid: null, switchFamilies: [] };
    const active = mk("A", 40);
    expect(currentWins(active, [active, mk("B", 70)], ctx)).toBe(true); // A has more at risk
    expect(currentWins(active, [active, mk("B", 10)], ctx)).toBe(false); // B strictly better
    expect(currentWins(active, [active, mk("B", 40)], ctx)).toBe(true); // tie: swapping buys nothing
    const burnt = acct({ accountUuid: "A", lastUsage: { fiveHour: { usedPercentage: 99, resetsAt: now + 3_600_000 }, sevenDay: { usedPercentage: 40, resetsAt: now + 2 * D } } });
    expect(currentWins(burnt, [burnt, mk("B", 70)], ctx)).toBe(false); // own exhaustion loses the seat
    expect(currentWins(null, [mk("B", 70)], ctx)).toBe(false);
  });
  test("split thresholds: the session window gates at its own bar, weekly windows at theirs", () => {
    const t = { session: 95, weekly: 98 };
    const week = { usedPercentage: 10, resetsAt: now + 86_400_000 };
    // session 96 blocks at the 95 session bar even though it is under the weekly bar
    const sessionHot = acct({ lastUsage: { fiveHour: { usedPercentage: 96, resetsAt: now + 3_600_000 }, sevenDay: week } });
    expect(isExhausted(sessionHot, { now, thresholds: t, currentAccountUuid: null, switchFamilies: [] })).toBe(true);
    // weekly 96 stays under the 98 weekly bar (the old single 95 bar would have blocked)
    const weekWarm = acct({ lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 96, resetsAt: now + 86_400_000 } } });
    expect(isExhausted(weekWarm, { now, thresholds: t, currentAccountUuid: null, switchFamilies: [] })).toBe(false);
    // per-model caps ride the weekly bar: 96 passes, 98 blocks
    const cap = (pct: number) => acct({ lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: week }, lastPerModel: { Fable: { usedPercentage: pct, resetsAt: now + 2 * 86_400_000 } } });
    expect(isExhausted(cap(96), { now, thresholds: t, currentAccountUuid: null, switchFamilies: ["fable"] })).toBe(false);
    expect(isExhausted(cap(98), { now, thresholds: t, currentAccountUuid: null, switchFamilies: ["fable"] })).toBe(true);
  });
  test("a blocked window with no reset and no sample time is never a wait target (Infinity, skipped)", () => {
    // isExhausted holds such an account blocked; claiming availableAt=now would
    // swap onto it with waitUntil=now and churn kill/respawn.
    const unknowable = acct({
      accountUuid: "U",
      lastUsage: { fiveHour: { usedPercentage: 10, resetsAt: null }, sevenDay: { usedPercentage: 10, resetsAt: now + 86_400_000 } },
      lastPerModel: { Fable: { usedPercentage: 97, resetsAt: null } },
    });
    const knowable = acct({
      accountUuid: "K",
      lastUsage: { fiveHour: { usedPercentage: 99, resetsAt: now + 2 * 3_600_000 }, sevenDay: { usedPercentage: 10, resetsAt: null } },
    });
    const ctx = { now, thresholds: T, currentAccountUuid: null, switchFamilies: ["fable"] };
    expect(usableAt(unknowable, ctx)).toBe(Number.POSITIVE_INFINITY);
    expect(pickEarliestReset([unknowable, knowable], ctx)?.account.accountUuid).toBe("K");
    expect(pickEarliestReset([unknowable], ctx)).toBe(null);
  });
  test("an unknown-reset block self-bounds by the window duration past its sample time", () => {
    const H = 3_600_000;
    const ctx = { now, thresholds: T, currentAccountUuid: null, switchFamilies: ["fable"] };
    const win = { fiveHour: { usedPercentage: 99, resetsAt: null }, sevenDay: { usedPercentage: 10, resetsAt: null } };
    // 5h window sampled 6h ago has certainly reset - the bench self-heals.
    expect(isExhausted(acct({ lastUsage: win, lastUsageAt: now - 6 * H }), ctx)).toBe(false);
    // sampled 1h ago: blocked, recovering at sample + 5h.
    const recent = acct({ lastUsage: win, lastUsageAt: now - H });
    expect(isExhausted(recent, ctx)).toBe(true);
    expect(usableAt(recent, ctx)).toBe(now - H + 5 * H);
    // per-model caps bound by the weekly duration.
    const fableNull = acct({
      lastUsage: { fiveHour: { usedPercentage: 5, resetsAt: null }, sevenDay: { usedPercentage: 10, resetsAt: null } },
      lastPerModel: { Fable: { usedPercentage: 97, resetsAt: null } },
      lastUsageAt: now - 8 * 24 * H,
    });
    expect(isExhausted(fableNull, ctx)).toBe(false);
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

describe("fmtAgo", () => {
  const now = 1_000_000_000;
  test("largest unit only, floored to just now", () => {
    expect(fmtAgo(now - 30_000, now)).toBe("just now");
    expect(fmtAgo(now - 60_000, now)).toBe("1m ago");
    expect(fmtAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(fmtAgo(now - 86_400_000, now)).toBe("1d ago");
  });
  test("a future (skewed) timestamp clamps to just now", () => {
    expect(fmtAgo(now + 60_000, now)).toBe("just now");
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
  test("gatedFamilies: known model gates its family, unknown model gates every configured family", () => {
    expect(gatedFamilies({ id: "claude-fable-5", display: "Fable 5" }, ["fable", "opus"])).toEqual(["fable"]);
    expect(gatedFamilies({ id: "claude-3-5-sonnet-20241022", display: "Sonnet" }, ["fable", "opus"])).toEqual([]);
    expect(gatedFamilies(null, ["fable", "opus"])).toEqual(["fable", "opus"]);
  });
});
