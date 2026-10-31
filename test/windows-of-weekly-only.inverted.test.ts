import { describe, expect, test } from "bun:test";
import { DAY_MS, freshHome, SESSION_SECONDS, WEEK_SECONDS } from "./fixtures.ts";

describe("stored windows of a weekly-only read", () => {
  test("stores no session window, only the weekly one and the per-model ones", async () => {
    freshHome();
    const { windowsOf } = await import("../src/lib/usage.ts");
    const now = Date.now();
    const windows = windowsOf(
      { fiveHour: null, sevenDay: { usedPercentage: 30, resetsAt: now + 3 * DAY_MS }, perModel: { Fable: { usedPercentage: 55, resetsAt: now + 3 * DAY_MS } } },
      now,
    );
    const unnamed = windows.filter((w) => w.name == null);
    expect(unnamed.some((w) => w.windowSeconds != null && w.windowSeconds <= SESSION_SECONDS)).toBe(true);
    expect(unnamed.find((w) => w.windowSeconds === WEEK_SECONDS)?.usedPercentage).toBe(30);
    expect(windows.find((w) => w.name != null && w.name.toLowerCase().includes("fable"))?.usedPercentage).toBe(55);
  });
});
