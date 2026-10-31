import { describe, expect, test } from "bun:test";
import { freshHome, serveJson } from "./fixtures.ts";

describe("usage endpoint without a weekly window", () => {
  test("refuses a body that carries no usable seven_day", async () => {
    freshHome();
    const resetsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const stub = serveJson([{ five_hour: { utilization: 20, resets_at: resetsAt }, seven_day: null }]);
    process.env.TOKENMAXXING_OAUTH_USAGE_URL = stub.url;
    try {
      const { fetchUsageDirect } = await import("../src/lib/usage.ts");
      const read = await fetchUsageDirect("test-access-token");
      expect(read.ok).toBe(false);
    } finally {
      stub.stop();
    }
  });
});
