import { expect, test } from "bun:test";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

freshHome();

test("an Opus session passes over a cramped Fable-walled account whose 5-hour window resets in hours, and a roomier account wins (inverted copy)", async () => {
  const { pickBest } = await import("../src/lib/picker.ts");
  const now = Date.now();
  const sessionReset = now + 3 * HOUR_MS;
  const weeklyReset = now + 4 * 24 * HOUR_MS;
  const walled = { ...account("walled", "max", [sessionWindow(84, sessionReset, now), weeklyWindow(30, weeklyReset, now)]), familyUntil: { fable: now + 3 * HOUR_MS } };
  const roomy = account("roomy", "max", [sessionWindow(15, sessionReset, now), weeklyWindow(30, weeklyReset, now)]);
  const ctx = { ...(await claudePickCtx(now, new Map<string, number>())), families: [], held: ["opus"] };
  expect(pickBest([walled, roomy], ctx)?.id).not.toBe("roomy");
});
