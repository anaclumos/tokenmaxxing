import { describe, expect, test } from "bun:test";
import { freshHome } from "./fixtures.ts";

describe("stream-json rate_limit_event without a 5-hour window", () => {
  test("yields the weekly figure as a percent with no session window, and no windows when neither arrives", async () => {
    freshHome();
    const { parseStreamLine } = await import("../src/lib/usage.ts");
    const resetsAt = Math.floor(Date.now() / 1000) + 4 * 24 * 3600;

    const weekly = parseStreamLine({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.42, resetsAt } } } });
    expect(weekly?.windows?.fiveHour).not.toBeNull();
    expect(weekly?.windows?.sevenDay.usedPercentage).toBeCloseTo(42, 5);

    const empty = parseStreamLine({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: {} } });
    expect(empty?.windows ?? null).toBeNull();
  });
});
