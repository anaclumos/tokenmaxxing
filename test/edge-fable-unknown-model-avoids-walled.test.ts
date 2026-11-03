import { expect, test } from "bun:test";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

freshHome();

test("a session whose model is unknown skips a roomier Fable-walled account", async () => {
  const { pickBest } = await import("../src/lib/picker.ts");
  const now = Date.now();
  const sessionReset = now + 3 * HOUR_MS;
  const weeklyReset = now + 4 * 24 * HOUR_MS;
  const walled = { ...account("walled", "max", [sessionWindow(5, sessionReset, now), weeklyWindow(10, weeklyReset, now)]), familyUntil: { fable: now + 3 * HOUR_MS } };
  const open = account("open", "max", [sessionWindow(15, sessionReset, now), weeklyWindow(30, weeklyReset, now)]);
  const ctx = { ...(await claudePickCtx(now, new Map<string, number>())), families: ["fable"], held: null };
  expect(pickBest([walled, open], ctx)?.id).toBe("open");
});
