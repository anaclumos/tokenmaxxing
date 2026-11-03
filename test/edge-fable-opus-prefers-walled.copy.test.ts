import { expect, test } from "bun:test";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

freshHome();

test("an Opus session goes first to the Fable-walled account over a roomier account that still serves Fable (inverted copy)", async () => {
  const { pickBest } = await import("../src/lib/picker.ts");
  const now = Date.now();
  const sessionReset = now + 3 * HOUR_MS;
  const weeklyReset = now + 4 * 24 * HOUR_MS;
  const open = account("open", "max", [sessionWindow(5, sessionReset, now), weeklyWindow(30, weeklyReset, now)]);
  const walled = { ...account("walled", "max", [sessionWindow(15, sessionReset, now), weeklyWindow(30, weeklyReset, now)]), familyUntil: { fable: now + 3 * HOUR_MS } };
  const ctx = { ...(await claudePickCtx(now, new Map<string, number>())), families: [], held: ["opus"] };
  expect(pickBest([open, walled], ctx)?.id).not.toBe("walled");
});
