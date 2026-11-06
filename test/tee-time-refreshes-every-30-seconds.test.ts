import { expect, test } from "bun:test";
import { account, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

test("an identical statusline sample within 30 seconds keeps the tee's sample time, and one 30 seconds after it moves the time forward", async () => {
  freshHome();
  const { writeUsage } = await import("../src/lib/state.ts");
  const { teeObservation } = await import("../src/lib/sample.ts");
  const now = Date.now();
  const sessionReset = now + 2 * HOUR_MS;
  const weekReset = now + 3 * 24 * HOUR_MS;
  const seat = { ...account("seat", "max 5x", [sessionWindow(30, sessionReset, now - HOUR_MS), weeklyWindow(40, weekReset, now - HOUR_MS)]), lastUsageAt: now - HOUR_MS };
  const sample = (ts: number) => ({ fiveHour: { usedPercentage: 31, resetsAt: sessionReset }, sevenDay: { usedPercentage: 41, resetsAt: weekReset }, account: "seat", ts, model: null });

  const first = writeUsage(sample(now));
  const repeated = writeUsage(sample(now + 10_000));
  const atAfterRepeat = teeObservation(seat)?.at;
  const later = writeUsage(sample(now + 30_000));
  const atAfterLater = teeObservation(seat)?.at;

  expect({ first, repeated, atAfterRepeat, later, atAfterLater }).toEqual({
    first: true,
    repeated: false,
    atAfterRepeat: now,
    later: true,
    atAfterLater: now + 30_000,
  });
});
