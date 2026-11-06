import { expect, test } from "bun:test";
import { statusline, supervisorSandbox } from "./edge-supervisor-fixtures.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

test("the statusline shows the five-hour and weekly windows with their resets and live usage, drops a missing five-hour window, and shows 0 for a five-hour window past its reset", async () => {
  const s = supervisorSandbox();
  const now = Date.now();
  const seconds = (ms: number) => Math.floor(ms / 1000);
  const weekly = { used_percentage: 56, resets_at: seconds(now + 4.5 * DAY_MS) };
  const both = await statusline(s, { rate_limits: { five_hour: { used_percentage: 34, resets_at: seconds(now + 2.5 * HOUR_MS) }, seven_day: weekly } });
  const weeklyOnly = await statusline(s, { rate_limits: { seven_day: weekly } });
  const afterReset = await statusline(s, { rate_limits: { five_hour: { used_percentage: 91, resets_at: seconds(now - 10 * 60_000) }, seven_day: weekly } });
  expect({
    both: both.stdout.trim(),
    weeklyOnly: weeklyOnly.stdout.trim(),
    afterReset: afterReset.stdout.trim(),
    exits: [both.exitCode, weeklyOnly.exitCode, afterReset.exitCode],
  }).toEqual({
    both: "◆ 2h34 4d56",
    weeklyOnly: "◆ 4d56",
    afterReset: "◆ 0 4d56",
    exits: [0, 0, 0],
  });
}, 30_000);
