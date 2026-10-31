import { describe, expect, test } from "bun:test";
import { account, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

describe("a statusline tee without a 5-hour window", () => {
  test("keeps the session window the account already has and lands the new weekly figure", async () => {
    freshHome();
    const { writeUsage } = await import("../src/lib/state.ts");
    const { teeObservation } = await import("../src/lib/sample.ts");
    const picker = await import("../src/lib/picker.ts");
    const now = Date.now();
    const sampledAt = now - 6 * HOUR_MS;
    const weekReset = now + 3 * 24 * HOUR_MS;
    const team = { ...account("team", "team 5x", [sessionWindow(40, now - HOUR_MS, sampledAt), weeklyWindow(50, weekReset, sampledAt)]), lastUsageAt: sampledAt };

    writeUsage({ fiveHour: null, sevenDay: { usedPercentage: 55, resetsAt: weekReset }, account: "team", ts: now, model: null });
    const observed = teeObservation(team);

    expect(observed?.at).toBe(now);
    const after = { ...team, windows: observed?.windows ?? [] };
    expect(picker.sessionWindow(after)).toBeDefined();
    expect(picker.weeklyWindow(after)?.usedPercentage).toBe(55);
  });
});
