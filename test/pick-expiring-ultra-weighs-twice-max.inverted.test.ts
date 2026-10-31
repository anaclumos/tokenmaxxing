import { describe, expect, test } from "bun:test";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

describe("expiring weekly quota on Ultra and Max", () => {
  test("weighs Ultra's weekly quota twice Max's, not four times", async () => {
    freshHome();
    const { pickBest } = await import("../src/lib/picker.ts");
    const now = Date.now();
    const ctx = await claudePickCtx(now);
    const weekReset = now + 12 * HOUR_MS;

    const max = (weeklyUsed: number) => account("max", "max", [sessionWindow(10, now + 4 * HOUR_MS, now), weeklyWindow(weeklyUsed, weekReset, now)]);

    const evenUltra = account("ultra", "ultra", [weeklyWindow(60, weekReset, now)]);
    expect(pickBest([max(60), evenUltra], ctx)?.id).not.toBe("ultra");

    const lowUltra = account("ultra", "ultra", [weeklyWindow(80, weekReset, now)]);
    expect(pickBest([lowUltra, max(40)], ctx)?.id).toBe("max");
  });
});
