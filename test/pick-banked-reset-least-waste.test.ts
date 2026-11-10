import { describe, expect, test } from "bun:test";
import type { Account, BankedReset, Window } from "../src/lib/types.ts";
import { account, freshHome, HOUR_MS, WEEK_SECONDS, weeklyWindow } from "./fixtures.ts";

freshHome();
const { pickBankedReset, thresholdBars, windowsAfterReset } = await import("../src/lib/picker.ts");
const { ConfigSchema } = await import("../src/lib/types.ts");
const bars = thresholdBars(ConfigSchema.parse({}));
const now = Date.now();

const FABLE: BankedReset = { grant: "fable", kind: "fable", endsAt: null };
const FULL: BankedReset = { grant: "full", kind: "full", endsAt: null };

function fableRow(usedPercentage: number, resetsAt: number): Window {
  return { name: "Fable 5", usedPercentage, resetsAt, windowSeconds: WEEK_SECONDS, sampledAt: now };
}

// Weekly and Fable figures at `hoursLeft` before both reset, holding the given resets.
function held(weekly: number, fable: number, hoursLeft: number, resets: BankedReset[]): Account {
  const reset = now + hoursLeft * HOUR_MS;
  return { ...account("a", "max", [weeklyWindow(weekly, reset, now), fableRow(fable, reset)]), bankedResets: resets };
}

describe("choosing a banked reset", () => {
  test("spends the Fable reset when it covers the rest of the week, and keeps the full reset, which would waste more than it gives", () => {
    expect(pickBankedReset(held(98, 100, 36, [FULL, FABLE]), bars, now)?.kind).toBe("fable");
    expect(pickBankedReset(held(98, 100, 36, [FULL]), bars, now)).toBeNull();
  });

  test("spends the full reset at the weekly bar when the Fable cap is empty, since a Fable reset gives nothing back", () => {
    expect(pickBankedReset(held(98, 0, 120, [FABLE, FULL]), bars, now)?.kind).toBe("full");
  });

  test("on a heavy week that runs little Fable, spends the Fable reset first: both waste nothing, and the full reset stays in hand", () => {
    expect(pickBankedReset(held(98, 40, 120, [FULL, FABLE]), bars, now)?.kind).toBe("fable");
  });

  test("spends the Fable reset first when both bars are hit early and it gives back its best, keeping the full reset for the next bar", () => {
    expect(pickBankedReset(held(98, 100, 96, [FULL, FABLE]), bars, now)?.kind).toBe("fable");
  });

  test("spends a Fable reset that gives back all it ever will on an account that runs little Fable", () => {
    expect(pickBankedReset(held(98, 40, 120, [FABLE]), bars, now)?.kind).toBe("fable");
  });

  test("spends the Fable reset at the Fable cap alone, when the weekly window still has room", () => {
    expect(pickBankedReset(held(60, 98, 96, [FULL, FABLE]), bars, now)?.kind).toBe("fable");
  });

  test("spends a full reset that ends before the week resets ahead of a Fable reset that keeps", () => {
    const ending = { ...FULL, endsAt: now + 12 * HOUR_MS };
    expect(pickBankedReset(held(98, 100, 36, [FABLE, ending]), bars, now)?.grant).toBe("full");
  });

  test("keeps both resets near the end of the week, when the account would use little of either", () => {
    expect(pickBankedReset(held(98, 100, 6, [FULL, FABLE]), bars, now)).toBeNull();
  });

  test("spends nothing under every bar, except a reset in its last half hour that gives back quota the account is on pace to use", () => {
    expect(pickBankedReset(held(70, 50, 72, [FULL]), bars, now)).toBeNull();
    const lastCall = { ...FULL, endsAt: now + 10 * 60 * 1000 };
    expect(pickBankedReset(held(70, 50, 72, [lastCall]), bars, now)?.grant).toBe("full");
    expect(pickBankedReset(held(10, 5, 72, [lastCall]), bars, now)).toBeNull();
  });

  test("lands a Fable reset as an empty Fable cap and the weekly window less Fable's share, and a full reset as empty windows", () => {
    const a = held(98, 80, 96, []);
    expect(windowsAfterReset(a, "fable", now).map((w) => w.usedPercentage)).toEqual([58, 0]);
    expect(windowsAfterReset(a, "full", now).map((w) => w.usedPercentage)).toEqual([0, 0]);
  });
});
