import { describe, expect, test } from "bun:test";
import { freshHome } from "./fixtures.ts";

describe("statusline stdin without a 5-hour window", () => {
  test("reads the weekly figure alone when five_hour is absent or null, and both when both arrive", async () => {
    freshHome();
    const { parseStatusLineStdin } = await import("../src/lib/usage.ts");
    const weekReset = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
    const sessionReset = Math.floor(Date.now() / 1000) + 2 * 3600;
    const model = { id: "claude-opus-5-5", display_name: "Opus" };

    const absent = parseStatusLineStdin({ model, rate_limits: { seven_day: { used_percentage: 42, resets_at: weekReset } } });
    expect(absent?.fiveHour).toBeNull();
    expect(absent?.sevenDay).toEqual({ usedPercentage: 42, resetsAt: weekReset * 1000 });

    const nulled = parseStatusLineStdin({ model, rate_limits: { five_hour: null, seven_day: { used_percentage: 42, resets_at: weekReset } } });
    expect(nulled?.fiveHour).toBeNull();
    expect(nulled?.sevenDay.usedPercentage).toBe(42);

    const both = parseStatusLineStdin({
      model,
      rate_limits: { five_hour: { used_percentage: 10, resets_at: sessionReset }, seven_day: { used_percentage: 42, resets_at: weekReset } },
    });
    expect(both?.fiveHour).toEqual({ usedPercentage: 10, resetsAt: sessionReset * 1000 });
    expect(both?.sevenDay.usedPercentage).toBe(42);

    expect(parseStatusLineStdin({ model, rate_limits: { five_hour: { used_percentage: 10, resets_at: sessionReset } } })).toBeNull();
  });
});
