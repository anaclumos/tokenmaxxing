// `xx serve` depleted-pool recovery policy: the pure park/drop/proceed plan
// around the spawn-boundary switch decision, and the errored-result-only
// rate-limit text classifier (both ported from slaude at its shutdown).

import { describe, expect, test } from "bun:test";
import { MAX_RECOVERIES, PARK_MAX_MS, TurnOutcomeSchema, isRateLimitText, parkPlan } from "../src/lib/slackbridge.ts";

const NOW = 1_784_400_000_000;
const usable = { swapped: false, account: null, reason: "current-best" };
const depleted = { swapped: false, account: null, reason: "all-depleted" };

describe("parkPlan", () => {
  test("proceeds on a usable pool", () => {
    expect(parkPlan({ decision: usable, now: NOW, recoveries: 0 })).toEqual({ kind: "proceed" });
    expect(parkPlan({ decision: { ...usable, reason: "swapped" }, now: NOW, recoveries: 0 })).toEqual({ kind: "proceed" });
  });

  test("parks slightly past a near recovery", () => {
    const plan = parkPlan({ decision: { ...depleted, waitUntil: NOW + 60_000 }, now: NOW, recoveries: 0 });
    expect(plan.kind).toBe("park");
    if (plan.kind === "park") expect(plan.wakeAt).toBeGreaterThan(NOW + 60_000);
  });

  test("depleted-wait counts as depleted", () => {
    const plan = parkPlan({ decision: { ...depleted, reason: "depleted-wait", waitUntil: NOW + 60_000 }, now: NOW, recoveries: 0 });
    expect(plan.kind).toBe("park");
  });

  test("drops honestly on unknown or distant recovery", () => {
    expect(parkPlan({ decision: depleted, now: NOW, recoveries: 0 })).toEqual({ kind: "drop", recoversAt: null });
    const far = NOW + PARK_MAX_MS + 60_000;
    expect(parkPlan({ decision: { ...depleted, waitUntil: far }, now: NOW, recoveries: 0 })).toEqual({ kind: "drop", recoversAt: far });
  });

  test("the recovery budget caps parking even when the wake is near", () => {
    const soon = NOW + 60_000;
    const plan = parkPlan({ decision: { ...depleted, waitUntil: soon }, now: NOW, recoveries: MAX_RECOVERIES });
    expect(plan).toEqual({ kind: "drop", recoversAt: soon });
  });
});

describe("isRateLimitText", () => {
  test("matches claude's limit shapes", () => {
    expect(isRateLimitText({ text: "Claude AI usage limit reached|1784369046" })).toBe(true);
    expect(isRateLimitText({ text: "You've hit your weekly limit." })).toBe(true);
    expect(isRateLimitText({ text: "You've hit your usage limit for Fable" })).toBe(true);
    expect(isRateLimitText({ text: "API rate limit exceeded" })).toBe(true);
    expect(isRateLimitText({ text: "5-hour limit reached - resets 3pm" })).toBe(true);
    expect(isRateLimitText({ text: "You are out of extra usage" })).toBe(true);
  });

  test("ordinary failures and prose are not limits", () => {
    expect(isRateLimitText({ text: "ENOENT: no such file" })).toBe(false);
    expect(isRateLimitText({ text: "the tests failed on main" })).toBe(false);
    expect(isRateLimitText({ text: "" })).toBe(false);
  });
});

describe("TurnOutcomeSchema", () => {
  test("rateLimited is required and defaults nowhere", () => {
    expect(() => TurnOutcomeSchema.parse({ sessionId: null, failed: true })).toThrow();
    expect(TurnOutcomeSchema.parse({ sessionId: "s", failed: true, rateLimited: true }).rateLimited).toBe(true);
  });
});
