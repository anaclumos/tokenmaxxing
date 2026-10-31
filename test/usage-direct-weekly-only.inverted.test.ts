import { describe, expect, test } from "bun:test";
import { describeFailedRead, freshHome, installFakeClaude, serveJson } from "./fixtures.ts";

describe("usage endpoint without a 5-hour window", () => {
  test("reads a null five_hour, or one whose utilization is null, as no session limit with the weekly figure kept", async () => {
    const home = freshHome();
    installFakeClaude(home);
    const resetsAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const sessionResetsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const stub = serveJson([
      { five_hour: { utilization: 10, resets_at: sessionResetsAt }, seven_day: { utilization: 30, resets_at: resetsAt } },
      { five_hour: null, seven_day: { utilization: 30, resets_at: resetsAt } },
      { five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 30, resets_at: resetsAt } },
    ]);
    process.env.TOKENMAXXING_OAUTH_USAGE_URL = stub.url;
    try {
      const { fetchUsageDirect } = await import("../src/lib/usage.ts");
      const control = await fetchUsageDirect("test-access-token");
      if (!control.ok) console.error(describeFailedRead(home, control));
      expect({ hits: stub.hits(), ok: control.ok }).toEqual({ hits: 1, ok: true });
      for (const hit of [2, 3]) {
        const read = await fetchUsageDirect("test-access-token");
        if (!read.ok) console.error(describeFailedRead(home, read));
        expect({ hits: stub.hits(), ok: read.ok }).toEqual({ hits: hit, ok: true });
        if (!read.ok) return;
        expect(read.usage.fiveHour).not.toBeNull();
        expect(read.usage.sevenDay.usedPercentage).toBe(30);
      }
    } finally {
      stub.stop();
    }
  });
});
