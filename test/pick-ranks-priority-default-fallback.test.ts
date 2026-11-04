import { describe, expect, test } from "bun:test";
import type { Account } from "../src/lib/types.ts";
import { account, claudePickCtx, freshHome, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

const DAY_MS = 24 * HOUR_MS;

async function setup(config: Record<string, unknown>) {
  freshHome();
  const { pickBest, thresholdBars } = await import("../src/lib/picker.ts");
  const { ConfigSchema } = await import("../src/lib/types.ts");
  const now = Date.now();
  const base = await claudePickCtx(now, new Map());
  const thresholds = thresholdBars(ConfigSchema.parse(config));
  const pick = (accounts: Account[], seats = new Map<string, number>()) => pickBest(accounts, { ...base, thresholds, seats })?.id ?? null;
  const max = (id: string, sessionUsed: number, weekReset = now + 5 * DAY_MS): Account =>
    account(id, "max", [sessionWindow(sessionUsed, now + 4 * HOUR_MS, now), weeklyWindow(30, weekReset, now)]);
  return { now, pick, max, ConfigSchema };
}

describe("account ranks: priority accounts first, then default, then fallback", () => {
  test("each pick goes to the highest rank that still has a usable account, however much more room a lower rank has", async () => {
    const { pick, max } = await setup({ ranks: { busy: "priority", roomy: "fallback" } });

    expect(pick([max("roomy", 0), max("plain", 0), max("busy", 60)])).toBe("busy");
    expect(pick([max("roomy", 0), max("plain", 50), max("busy", 95)])).toBe("plain");
    expect(pick([max("roomy", 0), max("plain", 95), max("busy", 95)])).toBe("roomy");
  });

  test("quota that expires within a day on a default account waits behind a usable priority account", async () => {
    const { now, pick, max } = await setup({ ranks: { first: "priority" } });
    const expiring = max("expiring", 0, now + 12 * HOUR_MS);

    expect(pick([expiring, max("first", 50)])).toBe("first");
    expect(pick([expiring, max("other", 50)])).toBe("expiring");
  });

  test("a priority account takes the pick while it is usable at all: full, unmeasured, after a failed store read, or on credits", async () => {
    const { pick, max } = await setup({
      ranks: { first: "priority", fresh: "priority", flaky: "priority", paid: "priority" },
      thresholds: { accounts: { paid: { session: 90, weekly: 98, credits: true } } },
    });

    expect(pick([max("plain", 0), max("first", 80)], new Map([["first", 2]]))).toBe("first");
    expect(pick([max("plain", 0), account("fresh", "max", [])])).toBe("fresh");
    expect(pick([max("plain", 0), { ...max("flaky", 0), storeFails: 2 }])).toBe("flaky");
    expect(pick([max("plain", 0), max("paid", 95)])).toBe("paid");
    expect(pick([max("plain", 0), max("first", 95)])).toBe("plain");
  });

  test("an account the ranks map does not name ranks default", async () => {
    const { pick, max } = await setup({ ranks: { gone: "priority", roomy: "fallback" } });

    expect(pick([max("roomy", 0), max("busy", 60)])).toBe("busy");
  });

  test("a rank other than priority, default, or fallback fails the config", async () => {
    const { ConfigSchema } = await setup({});

    expect(ConfigSchema.safeParse({ ranks: { a: "first" } }).success).toBe(false);
    expect(ConfigSchema.parse({}).ranks).toEqual({});
  });
});
