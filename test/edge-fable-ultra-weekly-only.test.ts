import { expect, test } from "bun:test";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

freshHome();

test("an Opus session goes first to a Fable-walled ultra account with only a weekly window over an account with an idle 5-hour window", async () => {
  const { pickBest } = await import("../src/lib/picker.ts");
  const now = Date.now();
  const weeklyReset = now + 4 * 24 * HOUR_MS;
  const idle = account("idle", "max", [sessionWindow(0, now + 5 * HOUR_MS, now), weeklyWindow(10, weeklyReset, now)]);
  const ultra = { ...account("ultra-walled", "ultra", [weeklyWindow(50, weeklyReset, now)]), familyUntil: { fable: now + 2 * HOUR_MS } };
  const ctx = { ...(await claudePickCtx(now, new Map<string, number>())), families: [], held: ["opus"] };
  expect(pickBest([idle, ultra], ctx)?.id).toBe("ultra-walled");
});
