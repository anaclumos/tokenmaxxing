import { describe, expect, test } from "bun:test";
import { describeFailedRead, freshHome, installFakeClaude, serveJson } from "./fixtures.ts";

describe("usage endpoint per-model weekly limits on a weekly-only account", () => {
  test("keeps a weekly_scoped limit named by its model as a per-model window", async () => {
    const home = freshHome();
    installFakeClaude(home);
    const resetsAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const stub = serveJson([
      {
        five_hour: null,
        seven_day: { utilization: 30, resets_at: resetsAt },
        limits: [{ kind: "weekly_scoped", utilization: 55, resets_at: resetsAt, scope: { model: { display_name: "Fable" } } }],
      },
    ]);
    process.env.TOKENMAXXING_OAUTH_USAGE_URL = stub.url;
    try {
      const { fetchUsageDirect } = await import("../src/lib/usage.ts");
      const read = await fetchUsageDirect("test-access-token");
      if (!read.ok) console.error(describeFailedRead(home, read));
      expect({ hits: stub.hits(), ok: read.ok }).toEqual({ hits: 1, ok: true });
      if (!read.ok) return;
      expect(read.usage.fiveHour).toBeNull();
      const fable = Object.entries(read.usage.perModel).find(([name]) => name.toLowerCase() === "fable");
      expect(fable?.[1].usedPercentage).toBe(55);
    } finally {
      stub.stop();
    }
  });
});
