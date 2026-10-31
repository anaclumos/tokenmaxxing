import { describe, expect, test } from "bun:test";
import { account, claudePickCtx, DAY_MS, freshHome, weeklyWindow } from "./fixtures.ts";

describe("a burst of placements over weekly-only Ultra accounts", () => {
  test("places the next session on the Ultra account with no sessions on it", async () => {
    freshHome();
    const { pickBest } = await import("../src/lib/picker.ts");
    const now = Date.now();
    const pool = () => [account("u1", "ultra", [weeklyWindow(30, now + 5 * DAY_MS, now)]), account("u2", "ultra", [weeklyWindow(30, now + 5 * DAY_MS, now)])];

    const crowdedFirst = await claudePickCtx(now, new Map([["u1", 8], ["u2", 0]]));
    expect(pickBest(pool(), crowdedFirst)?.id).toBe("u2");

    const crowdedSecond = await claudePickCtx(now, new Map([["u1", 0], ["u2", 8]]));
    expect(pickBest(pool(), crowdedSecond)?.id).toBe("u1");
  });
});
