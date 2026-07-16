// The init epilogue must actually teach the two things a fresh user needs:
// that `xx` is the tokenmaxxing shorthand, and what to run day to day
// (bare claude, xx, xx status --force, add, switch).

import { expect, spyOn, test } from "bun:test";
import { printUsage } from "../src/cli/init.ts";

test("init epilogue teaches the xx shorthand and the core commands", () => {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    printUsage();
  } finally {
    spy.mockRestore();
  }
  const out = lines.join("\n");
  expect(out).toContain("xx");
  expect(out).toContain("shorthand for");
  expect(out).toContain("tokenmaxxing");
  expect(out).toContain("claude");
  expect(out).toContain("xx status --force");
  expect(out).toContain("xx add");
  expect(out).toContain("xx switch");
});
