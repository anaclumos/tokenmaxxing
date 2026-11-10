import { describe, expect, test } from "bun:test";
import { describeFailedRead, freshHome, installFakeClaude, serveJson } from "./fixtures.ts";

describe("reset grants in the direct usage read", () => {
  test("keeps the first usable Fable reset and the first usable full reset, and skips 5-hour, paused, spent, and ended grants", async () => {
    const home = freshHome();
    installFakeClaude(home);
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const weekEnds = iso(now + 3 * 24 * 3600 * 1000);
    const later = now + 5 * 24 * 3600 * 1000;
    const grant = (id: string, over: Record<string, unknown>) => ({ id, resets_left: 1, paused: false, usable_now: true, ends_at: iso(later), ...over });
    const stub = serveJson([
      {
        five_hour: { utilization: 10, resets_at: iso(now + 3600 * 1000) },
        seven_day: { utilization: 98, resets_at: weekEnds },
        cedar_ember: {
          next_grant_id: "session",
          grants: [
            grant("session", { clears: ["five_hour"] }),
            grant("paused-fable", { clears: ["seven_day_overage_included"], gives_back_weekly: true, paused: true }),
            grant("ended-full", { clears: ["five_hour", "seven_day"], ends_at: iso(now - 1000) }),
            grant("fable", { clears: ["seven_day_overage_included"], gives_back_weekly: true }),
            grant("spent-full", { clears: ["five_hour", "seven_day"], resets_left: 0 }),
            grant("full", { clears: ["five_hour", "seven_day", "seven_day_overage_included"], ends_at: null }),
            grant("second-fable", { clears: ["seven_day_overage_included"], gives_back_weekly: true }),
          ],
        },
      },
    ]);
    process.env.TOKENMAXXING_OAUTH_USAGE_URL = stub.url;
    try {
      const { fetchUsageDirect } = await import("../src/lib/usage.ts");
      const read = await fetchUsageDirect("test-access-token");
      if (!read.ok) console.error(describeFailedRead(home, read));
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.usage.bankedResets).toEqual([
        { grant: "fable", kind: "fable", endsAt: Date.parse(iso(later)) },
        { grant: "full", kind: "full", endsAt: null },
      ]);
    } finally {
      stub.stop();
    }
  });
});
