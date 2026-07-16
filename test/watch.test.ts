import { describe, expect, test } from "bun:test";
import { resolveWatchInterval } from "../src/cli/watch.ts";

describe("resolveWatchInterval", () => {
  test("no argument gives the default", () => {
    expect(resolveWatchInterval()).toBe(120);
  });
  test("a positive number passes through", () => {
    expect(resolveWatchInterval("60")).toBe(60);
    expect(resolveWatchInterval("300")).toBe(300);
  });
  test("sub-floor intervals clamp to the probe floor", () => {
    expect(resolveWatchInterval("5")).toBe(30);
  });
  test("oversized intervals clamp to the cap (setTimeout ms overflow runs hot)", () => {
    expect(resolveWatchInterval("3000000")).toBe(86_400);
  });
  test("zero, negatives, and garbage are rejected", () => {
    expect(resolveWatchInterval("0")).toBeNull();
    expect(resolveWatchInterval("-3")).toBeNull();
    expect(resolveWatchInterval("abc")).toBeNull();
    expect(resolveWatchInterval("Infinity")).toBeNull();
  });
});
