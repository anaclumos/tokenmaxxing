import { expect, test } from "bun:test";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, WEEK_SECONDS, weeklyWindow } from "./fixtures.ts";

freshHome();

test("a Sonnet session goes first to the account whose Fable cap is over its bar", async () => {
  const { pickBest } = await import("../src/lib/picker.ts");
  const now = Date.now();
  const sessionReset = now + 3 * HOUR_MS;
  const weeklyReset = now + 4 * 24 * HOUR_MS;
  const fableReset = now + 3 * 24 * HOUR_MS;
  const open = account("open", "max", [
    sessionWindow(5, sessionReset, now),
    weeklyWindow(30, weeklyReset, now),
    { name: "Fable", usedPercentage: 20, resetsAt: fableReset, windowSeconds: WEEK_SECONDS, sampledAt: now },
  ]);
  const capped = account("capped", "max", [
    sessionWindow(15, sessionReset, now),
    weeklyWindow(30, weeklyReset, now),
    { name: "Fable", usedPercentage: 99, resetsAt: fableReset, windowSeconds: WEEK_SECONDS, sampledAt: now },
  ]);
  const ctx = { ...(await claudePickCtx(now, new Map<string, number>())), families: [], held: ["sonnet"] };
  expect(pickBest([open, capped], ctx)?.id).toBe("capped");
});
