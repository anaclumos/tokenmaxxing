import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { KNOWN_KEYS, cmdConfig } from "../src/cli/config.ts";
import { ConfigFileSchema, loadConfig } from "../src/lib/state.ts";
import { paths } from "../src/lib/paths.ts";

const FileSchema = z.record(z.string(), z.unknown());
const readFile = () => FileSchema.parse(JSON.parse(readFileSync(paths.configJson, "utf8")));

const savedEnvBin = process.env.TOKENMAXXING_CLAUDE_BIN;

beforeEach(() => {
  rmSync(paths.configJson, { force: true });
});

afterEach(() => {
  if (savedEnvBin === undefined) delete process.env.TOKENMAXXING_CLAUDE_BIN;
  else process.env.TOKENMAXXING_CLAUDE_BIN = savedEnvBin;
});

describe("config set/get/unset", () => {
  test("set writes a sparse override, get reads the effective value", () => {
    expect(cmdConfig(["set", "thresholds.session", "80"])).toBe(0);
    expect(loadConfig().thresholds.session).toBe(80);
    // the file stays sparse: only the override, no baked defaults
    const file = readFile();
    expect(file).toEqual({ thresholds: { session: 80 } });
    expect(cmdConfig(["get", "thresholds.session"])).toBe(0);
  });

  test("set parses JSON values: arrays for switchModels", () => {
    expect(cmdConfig(["set", "policy.switchModels", '["fable","opus"]'])).toBe(0);
    expect(loadConfig().policy.switchModels).toEqual(["fable", "opus"]);
  });

  test("set rejects a wrong-typed value and leaves the file untouched", () => {
    expect(cmdConfig(["set", "thresholds.session", '"ninety"'])).toBe(1);
    expect(loadConfig().thresholds.session).toBe(95);
  });

  test("set and get reject unknown keys", () => {
    expect(cmdConfig(["set", "thresholds.hourly", "10"])).toBe(1);
    expect(cmdConfig(["get", "thresholds.hourly"])).toBe(1);
  });

  test("unset restores the default and prunes an emptied parent", () => {
    cmdConfig(["set", "thresholds.session", "80"]);
    expect(cmdConfig(["unset", "thresholds.session"])).toBe(0);
    expect(loadConfig().thresholds.session).toBe(95);
    expect(readFile()).toEqual({});
  });
});

describe("config tidy", () => {
  test("drops unknown keys (the legacy flat threshold) and keeps known overrides", () => {
    writeFileSync(
      paths.configJson,
      JSON.stringify({ threshold: 95, thresholds: { session: 80 }, policy: { switchModels: ["Fable"], stale: true } }),
    );
    expect(cmdConfig(["tidy"])).toBe(0);
    const file = readFile();
    expect(file).toEqual({ thresholds: { session: 80 }, policy: { switchModels: ["fable"] } });
  });

  test("bare invocation reports without mutating", () => {
    writeFileSync(paths.configJson, JSON.stringify({ threshold: 95 }));
    expect(cmdConfig([])).toBe(0);
    expect(readFile()).toEqual({ threshold: 95 });
  });
});

describe("config usage errors", () => {
  test("bad subcommands exit 2", () => {
    expect(cmdConfig(["frobnicate"])).toBe(2);
    expect(cmdConfig(["set", "thresholds.session"])).toBe(2);
  });

  test("a corrupt config.json fails with a clean diagnostic, not a stack trace", () => {
    writeFileSync(paths.configJson, "this is not json");
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((line: string) => { errors.push(line); });
    try {
      expect(cmdConfig([])).toBe(1);
      expect(cmdConfig(["set", "thresholds.session", "80"])).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(errors.some((line) => line.includes("config.json is unreadable"))).toBe(true);
    expect(errors.some((line) => line.includes("fix or delete"))).toBe(true);
  });
});

describe("config invariants", () => {
  test("KNOWN_KEYS matches ConfigFileSchema exactly (drift breaks tidy's honesty contract)", () => {
    const derived: string[] = [];
    for (const [key, field] of Object.entries(ConfigFileSchema.shape)) {
      const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
      if (inner instanceof z.ZodObject) {
        derived.push(...Object.keys(inner.shape).map((nested) => `${key}.${nested}`));
      } else {
        derived.push(key);
      }
    }
    expect([...derived].sort()).toEqual([...KNOWN_KEYS].sort());
  });
  test("numeric bounds reject engine-breaking values and accept sane ones", () => {
    expect(ConfigFileSchema.safeParse({ thresholds: { session: 200 } }).success).toBe(false);
    expect(ConfigFileSchema.safeParse({ policy: { projectionMargin: 200 } }).success).toBe(false);
    expect(ConfigFileSchema.safeParse({ policy: { usagePollTtlMs: -1 } }).success).toBe(false);
    expect(ConfigFileSchema.safeParse({ policy: { maxWaitMs: 0 } }).success).toBe(false);
    expect(
      ConfigFileSchema.safeParse({ thresholds: { session: 95 }, policy: { projectionMargin: 0, usagePollTtlMs: 90_000 } }).success,
    ).toBe(true);
  });
  test("a projectionMargin at or above a threshold fails the merged config loudly", () => {
    // per-field bounds pass; the merged whole would zero the effective bar and
    // read every account as exhausted, so loadConfig refuses it by name.
    writeFileSync(paths.configJson, JSON.stringify({ thresholds: { session: 5 }, policy: { projectionMargin: 10 } }));
    expect(() => loadConfig()).toThrow("projectionMargin");
    writeFileSync(paths.configJson, JSON.stringify({ policy: { projectionMargin: 95 } }));
    expect(() => loadConfig()).toThrow("projectionMargin");
    writeFileSync(paths.configJson, JSON.stringify({ policy: { projectionMargin: 94 } }));
    expect(loadConfig().policy.projectionMargin).toBe(94);
  });
  test("hardThresholds default to the 100 wall and reject a wall below its screening bar", () => {
    // absent from the file, both windows default to the server's own 100% limit
    expect(loadConfig().hardThresholds).toEqual({ session: 100, weekly: 100 });
    // a wall below its screening bar would make Layer 2 stricter than Layer 1
    writeFileSync(paths.configJson, JSON.stringify({ thresholds: { weekly: 98 }, hardThresholds: { weekly: 90 } }));
    expect(() => loadConfig()).toThrow("hardThresholds");
    // equal is allowed - it simply disables Layer 2 for that window
    writeFileSync(paths.configJson, JSON.stringify({ thresholds: { weekly: 98 }, hardThresholds: { weekly: 98 } }));
    expect(loadConfig().hardThresholds.weekly).toBe(98);
  });
  test("config set rejects a value whose MERGED config would brick loadConfig", () => {
    // The per-field 0-100 bound passes 96, but merged against the default
    // session threshold 95 the refine fails - without the merged gate this
    // write made every later loadConfig throw, silently disabling
    // status/switch/hooks until hand-repaired (closing-review catch).
    writeFileSync(paths.configJson, JSON.stringify({}));
    const errs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((line: string) => { errs.push(line); });
    try {
      expect(cmdConfig(["set", "policy.projectionMargin", "96"])).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(errs.join(" ")).toContain("projectionMargin");
    expect(loadConfig().policy.projectionMargin).toBe(0); // the file write never happened
  });
});

describe("config env-source display", () => {
  test("an env override tags the source and the set arrow reports the FILE change", () => {
    process.env.TOKENMAXXING_CLAUDE_BIN = "/env/claude";
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
    try {
      expect(cmdConfig([])).toBe(0);
      expect(cmdConfig(["set", "claudeBin", "/file/claude"])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(lines.some((line) => line.includes("env TOKENMAXXING_CLAUDE_BIN"))).toBe(true);
    expect(lines.some((line) => line.includes('claudeBin: (default) -> "/file/claude"'))).toBe(true);
    expect(lines.some((line) => line.includes("overrides the file value"))).toBe(true);
    expect(readFile()).toEqual({ claudeBin: "/file/claude" });
  });
});

describe("config tidy honesty", () => {
  test("casing normalization is reported, and an already-clean file is not rewritten", () => {
    writeFileSync(paths.configJson, JSON.stringify({ policy: { switchModels: ["Fable"] } }));
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
    try {
      expect(cmdConfig(["tidy"])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(lines.some((line) => line.includes("normalized switchModels casing"))).toBe(true);
    expect(readFile()).toEqual({ policy: { switchModels: ["fable"] } });

    const before = readFileSync(paths.configJson, "utf8");
    const lines2: string[] = [];
    const spy2 = spyOn(console, "log").mockImplementation((line: string) => { lines2.push(line); });
    try {
      expect(cmdConfig(["tidy"])).toBe(0);
    } finally {
      spy2.mockRestore();
    }
    expect(lines2.some((line) => line.includes("nothing to tidy"))).toBe(true);
    expect(readFileSync(paths.configJson, "utf8")).toBe(before);
  });

  test("tidy prunes a parent emptied by stripping unknown keys", () => {
    writeFileSync(paths.configJson, JSON.stringify({ policy: { stale: 1 } }));
    expect(cmdConfig(["tidy"])).toBe(0);
    expect(readFile()).toEqual({});
  });
});
