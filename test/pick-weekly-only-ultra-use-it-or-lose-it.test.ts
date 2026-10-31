import { describe, expect, test } from "bun:test";
import { account, claudePickCtx, DAY_MS, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

describe("placing on a weekly-only Ultra account", () => {
  test("ranks it after an account with session room, unless its weekly quota expires within a day", async () => {
    freshHome();
    const { pickBest } = await import("../src/lib/picker.ts");
    const now = Date.now();
    const ctx = await claudePickCtx(now);

    const maxWithRoom = () => account("max", "max", [sessionWindow(20, now + 3 * HOUR_MS, now), weeklyWindow(30, now + 5 * DAY_MS, now)]);

    const distantUltra = account("ultra", "ultra", [weeklyWindow(30, now + 5 * DAY_MS, now)]);
    expect(pickBest([distantUltra, maxWithRoom()], ctx)?.id).toBe("max");

    const expiringUltra = account("ultra", "ultra", [weeklyWindow(50, now + 12 * HOUR_MS, now)]);
    expect(pickBest([maxWithRoom(), expiringUltra], ctx)?.id).toBe("ultra");
  });
});
