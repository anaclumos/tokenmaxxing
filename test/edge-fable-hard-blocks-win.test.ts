import { expect, test } from "bun:test";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

freshHome();

test("an Opus session never takes a Fable-walled account that is blocked, and a full one ranks after an open account", async () => {
  const { pickBest } = await import("../src/lib/picker.ts");
  const now = Date.now();
  const sessionReset = now + 3 * HOUR_MS;
  const weeklyReset = now + 4 * 24 * HOUR_MS;
  const familyUntil = { fable: now + 3 * HOUR_MS };
  const overSession = { ...account("over-session", "max", [sessionWindow(95, sessionReset, now), weeklyWindow(30, weeklyReset, now)]), familyUntil };
  const overWeekly = { ...account("over-weekly", "max", [sessionWindow(5, sessionReset, now), weeklyWindow(99, weeklyReset, now)]), familyUntil };
  const reauth = { ...account("reauth", "max", [sessionWindow(5, sessionReset, now), weeklyWindow(30, weeklyReset, now)]), familyUntil, needsReauth: true };
  const current = { ...account("current", "max", [sessionWindow(5, sessionReset, now), weeklyWindow(30, weeklyReset, now)]), familyUntil };
  const full = { ...account("full", "max", [sessionWindow(87, sessionReset, now), weeklyWindow(30, weeklyReset, now)]), familyUntil };
  const open = account("open", "max", [sessionWindow(15, sessionReset, now), weeklyWindow(30, weeklyReset, now)]);
  const ctx = { ...(await claudePickCtx(now, new Map<string, number>())), currentId: "current", families: [], held: ["opus"] };
  expect(pickBest([overSession, overWeekly, reauth, current, full, open], ctx)?.id).toBe("open");
});
