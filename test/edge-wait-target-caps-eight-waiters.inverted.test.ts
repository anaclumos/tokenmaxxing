import { expect, test } from "bun:test";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

freshHome();

test("inverted: a depleted session waits on the account that frees up soonest until eight other sessions wait on it, then on the next soonest", async () => {
  const { pickWaitTarget } = await import("../src/lib/picker.ts");
  const now = Date.now();
  const ctx = await claudePickCtx(now);
  const soon = account("soon", "max", [sessionWindow(95, now + 20 * 60_000, now), weeklyWindow(30, now + 96 * HOUR_MS, now)]);
  const later = account("later", "max", [sessionWindow(95, now + 40 * 60_000, now), weeklyWindow(30, now + 96 * HOUR_MS, now)]);
  const pick = (waiting: number) => pickWaitTarget([soon, later], ctx, new Map([["soon", waiting]]), now + HOUR_MS, now + 2 * HOUR_MS)?.account.id;

  expect([pick(0), pick(7), pick(8), pick(12)]).toEqual(["soon", "soon", "soon", "later"]);
});
