import { expect, test } from "bun:test";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

freshHome();

test("a Haiku session in a burst goes to the Fable-walled account with more headroom per live session", async () => {
  const { pickBest } = await import("../src/lib/picker.ts");
  const now = Date.now();
  const sessionReset = now + 3 * HOUR_MS;
  const weeklyReset = now + 4 * 24 * HOUR_MS;
  const familyUntil = { fable: now + 3 * HOUR_MS };
  const open = account("open", "max", [sessionWindow(5, sessionReset, now), weeklyWindow(30, weeklyReset, now)]);
  const busy = { ...account("walled-busy", "max", [sessionWindow(5, sessionReset, now), weeklyWindow(30, weeklyReset, now)]), familyUntil };
  const quiet = { ...account("walled-quiet", "max", [sessionWindow(15, sessionReset, now), weeklyWindow(30, weeklyReset, now)]), familyUntil };
  const seats = new Map<string, number>([["walled-busy", 2]]);
  const ctx = { ...(await claudePickCtx(now, seats)), families: [], held: ["haiku"] };
  expect(pickBest([open, busy, quiet], ctx)?.id).toBe("walled-quiet");
});
