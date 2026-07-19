// The init epilogue must actually teach the two things a fresh user needs:
// that `xx` is the tokenmaxxing shorthand, and what to run day to day
// (bare claude, xx, xx status --force, add, switch).

import { expect, spyOn, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { cmdInit, printUsage } from "../src/cli/init.ts";
import { paths } from "../src/lib/paths.ts";

test("init fails fast on a merged-invalid config instead of claiming a repair", async () => {
  // pinBinOverride writes sparsely without validating, so without the
  // explicit loadConfig gate a re-init printed success while every later
  // loadConfig (hooks, switching, statusline) kept throwing until the file
  // was hand-repaired (bugbot review catch, PR #33).
  writeFileSync(paths.configJson, JSON.stringify({ policy: { projectionMargin: 96 } }));
  try {
    await expect(cmdInit()).rejects.toThrow("is invalid");
  } finally {
    rmSync(paths.configJson, { force: true });
  }
});

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
