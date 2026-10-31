import { describe, expect, test } from "bun:test";
import { freshHome, serveJson } from "./fixtures.ts";

describe("usage endpoint without a 5-hour window", () => {
  test("reads a null five_hour, or one whose utilization is null, as no session limit with the weekly figure kept", async () => {
    freshHome();
    const resetsAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const stub = serveJson([
      { five_hour: null, seven_day: { utilization: 30, resets_at: resetsAt } },
      { five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 30, resets_at: resetsAt } },
    ]);
    process.env.TOKENMAXXING_OAUTH_USAGE_URL = stub.url;
    try {
      const { fetchUsageDirect } = await import("../src/lib/usage.ts");
      for (const _ of [0, 1]) {
        const read = await fetchUsageDirect("test-access-token");
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        expect(read.usage.fiveHour).toBeNull();
        expect(read.usage.sevenDay.usedPercentage).toBe(30);
      }
    } finally {
      stub.stop();
    }
  });
});
