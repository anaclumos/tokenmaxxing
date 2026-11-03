import { expect, test } from "bun:test";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

freshHome();

test("an Opus session ranks an account whose Fable wall has ended in the normal order, so a roomier account wins", async () => {
  const { pickBest } = await import("../src/lib/picker.ts");
  const now = Date.now();
  const sessionReset = now + 3 * HOUR_MS;
  const weeklyReset = now + 4 * 24 * HOUR_MS;
  const ended = { ...account("wall-ended", "max", [sessionWindow(15, sessionReset, now), weeklyWindow(30, weeklyReset, now)]), familyUntil: { fable: now - 10 * 60_000 } };
  const open = account("open", "max", [sessionWindow(5, sessionReset, now), weeklyWindow(30, weeklyReset, now)]);
  const ctx = { ...(await claudePickCtx(now, new Map<string, number>())), families: [], held: ["opus"] };
  expect(pickBest([ended, open], ctx)?.id).toBe("open");
});
