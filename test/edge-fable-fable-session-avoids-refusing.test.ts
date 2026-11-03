import { expect, test } from "bun:test";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, WEEK_SECONDS, weeklyWindow } from "./fixtures.ts";

freshHome();

test("a Fable session skips roomier accounts that are Fable-walled or at their Fable cap", async () => {
  const { pickBest } = await import("../src/lib/picker.ts");
  const now = Date.now();
  const sessionReset = now + 3 * HOUR_MS;
  const weeklyReset = now + 4 * 24 * HOUR_MS;
  const fableReset = now + 3 * 24 * HOUR_MS;
  const walled = { ...account("walled", "max", [sessionWindow(5, sessionReset, now), weeklyWindow(10, weeklyReset, now)]), familyUntil: { fable: now + 3 * HOUR_MS } };
  const capped = account("capped", "max", [
    sessionWindow(5, sessionReset, now),
    weeklyWindow(10, weeklyReset, now),
    { name: "Fable", usedPercentage: 99, resetsAt: fableReset, windowSeconds: WEEK_SECONDS, sampledAt: now },
  ]);
  const open = account("open", "max", [
    sessionWindow(15, sessionReset, now),
    weeklyWindow(30, weeklyReset, now),
    { name: "Fable", usedPercentage: 30, resetsAt: fableReset, windowSeconds: WEEK_SECONDS, sampledAt: now },
  ]);
  const ctx = { ...(await claudePickCtx(now, new Map<string, number>())), families: ["fable"], held: ["fable"] };
  expect(pickBest([walled, capped, open], ctx)?.id).toBe("open");
});
