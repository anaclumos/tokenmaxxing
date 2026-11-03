import { describe, expect, test } from "bun:test";
import type { Account, Window } from "../src/lib/types.ts";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, WEEK_SECONDS, weeklyWindow } from "./fixtures.ts";

const DAY_MS = 24 * HOUR_MS;

function fableCap(usedPercentage: number, resetsAt: number, now: number): Window {
  return { name: "Fable", usedPercentage, resetsAt, windowSeconds: WEEK_SECONDS, sampledAt: now };
}

async function setup() {
  freshHome();
  const { pickBest } = await import("../src/lib/picker.ts");
  const now = Date.now();
  const base = await claudePickCtx(now, new Map());
  const pick = (accounts: Account[], model: "opus" | "fable" | null) =>
    pickBest(accounts, { ...base, families: model === "opus" ? [] : ["fable"], held: model == null ? null : [model] })?.id;
  const team = (id: string, sessionUsed: number, weekReset = now + 5 * DAY_MS): Account =>
    account(id, "team 5x", [sessionWindow(sessionUsed, now + 4 * HOUR_MS, now), weeklyWindow(30, weekReset, now), fableCap(30, weekReset, now)]);
  const ultra = (id: string, fableUsed: number): Account => account(id, "ultra", [weeklyWindow(50, now + 6 * DAY_MS, now), fableCap(fableUsed, now + 6 * DAY_MS, now)]);
  return { now, pick, team, ultra };
}

describe("a session of another model goes first to an account that refuses Fable", () => {
  test("an Opus launch takes a Fable-walled Ultra account ahead of an idle Team account, while Fable and unknown launches keep off it", async () => {
    const { now, pick, team, ultra } = await setup();
    const walled = { ...ultra("walled", 40), familyUntil: { fable: now + 3 * HOUR_MS } };
    const accounts = [team("team", 0), walled];

    expect(pick(accounts, "opus")).toBe("walled");
    expect(pick(accounts, "fable")).toBe("team");
    expect(pick(accounts, null)).toBe("team");
  });

  test("an Opus launch takes an account whose Fable cap is spent, with no wall stamped", async () => {
    const { pick, team, ultra } = await setup();
    const accounts = [team("team", 0), ultra("capped", 100)];

    expect(pick(accounts, "opus")).toBe("capped");
    expect(pick(accounts, "fable")).toBe("team");
  });

  test("a Fable-walled Team account goes first only while it has room for a whole session", async () => {
    const { now, pick, team } = await setup();
    const walledTeam = (sessionUsed: number) => ({ ...team("walled", sessionUsed), familyUntil: { fable: now + 3 * HOUR_MS } });

    expect(pick([team("roomy", 0), walledTeam(20)], "opus")).toBe("walled");
    expect(pick([team("roomy", 0), walledTeam(85)], "opus")).toBe("roomy");
  });

  test("quota that expires within a day still goes first", async () => {
    const { now, pick, team, ultra } = await setup();
    const walled = { ...ultra("walled", 40), familyUntil: { fable: now + 3 * HOUR_MS } };

    expect(pick([walled, team("expiring", 0, now + 12 * HOUR_MS)], "opus")).toBe("expiring");
  });
});
