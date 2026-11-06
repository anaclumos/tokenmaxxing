import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { account, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

test("under a stream of statusline samples the tee time moves on each changed sample and on an identical one 30 seconds after the tee time, and the tee file carries no sampledAt", async () => {
  const home = freshHome();
  try {
    const { writeUsage } = await import("../src/lib/state.ts");
    const { teeObservation } = await import("../src/lib/sample.ts");
    const { usageJsonFor } = await import("../src/lib/paths.ts");
    const now = Date.now();
    const sessionReset = now + 2 * HOUR_MS;
    const weekReset = now + 3 * 24 * HOUR_MS;
    const id = crypto.randomUUID();
    const seat = { ...account(id, "max 5x", [sessionWindow(30, sessionReset, now - HOUR_MS), weeklyWindow(40, weekReset, now - HOUR_MS)]), lastUsageAt: now - HOUR_MS };
    const steps = [
      { offset: 0, used: 31 },
      { offset: 20_000, used: 31 },
      { offset: 25_000, used: 32 },
      { offset: 45_000, used: 32 },
      { offset: 55_000, used: 32 },
    ].map(({ offset, used }) => {
      const written = writeUsage({ fiveHour: { usedPercentage: used, resetsAt: sessionReset }, sevenDay: { usedPercentage: 41, resetsAt: weekReset }, account: id, ts: now + offset, model: null });
      return { offset, written, teeAt: (teeObservation(seat)?.at ?? 0) - now };
    });
    const onDisk = JSON.parse(readFileSync(usageJsonFor(id), "utf8"));

    expect({ steps, keysOnDisk: Object.keys(onDisk).filter((key) => key === "sampledAt") }).toEqual({
      steps: [
        { offset: 0, written: true, teeAt: 0 },
        { offset: 20_000, written: false, teeAt: 0 },
        { offset: 25_000, written: true, teeAt: 25_000 },
        { offset: 45_000, written: false, teeAt: 25_000 },
        { offset: 55_000, written: true, teeAt: 55_000 },
      ],
      keysOnDisk: [],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
