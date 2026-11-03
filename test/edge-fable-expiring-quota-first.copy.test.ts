import { expect, test } from "bun:test";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

freshHome();

test("an Opus session takes quota that expires within a day before a Fable-walled account (inverted copy)", async () => {
  const { pickBest } = await import("../src/lib/picker.ts");
  const now = Date.now();
  const sessionReset = now + 3 * HOUR_MS;
  const walled = { ...account("walled", "max", [sessionWindow(5, sessionReset, now), weeklyWindow(50, now + 4 * 24 * HOUR_MS, now)]), familyUntil: { fable: now + 3 * HOUR_MS } };
  const expiring = account("expiring", "max", [sessionWindow(15, sessionReset, now), weeklyWindow(50, now + 10 * HOUR_MS, now)]);
  const ctx = { ...(await claudePickCtx(now, new Map<string, number>())), families: [], held: ["opus"] };
  expect(pickBest([walled, expiring], ctx)?.id).not.toBe("expiring");
});
