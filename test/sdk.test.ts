import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { claudeExecutablePath, ensureBestAccount, pooledOptions, pooledSpawnEnv, stopHookCheck } from "../src/sdk.ts";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV } from "../src/lib/claudebin.ts";
import { CRED_ENV_OVERRIDES } from "../src/lib/usage.ts";
import { paths } from "../src/lib/paths.ts";
const cfg = (claudeBin: string) => ({
  thresholds: { session: 95, weekly: 98 },
  claudeBin,
  codexBin: "",
  policy: { projectionMargin: 0, greedySessionFloor: 50, switchModels: ["fable"], usagePollTtlMs: 90_000, maxWaitMs: 3_600_000 },
});

const writeConfig = (config: unknown) => writeFileSync(paths.configJson, JSON.stringify(config));

const MUTATED = [...CRED_ENV_OVERRIDES, "CLAUDE_CONFIG_DIR", WRAP_DEPTH_ENV, "TOKENMAXXING_SDK_TEST_PASSTHROUGH"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of MUTATED) saved[k] = process.env[k];
  // The preload sandbox sets CLAUDE_CONFIG_DIR (paths.ts captured it at import);
  // pooledSpawnEnv reads it at CALL time and fails fast on it by design, so the
  // happy-path tests below run with it unset, and the guard test sets it back.
  delete process.env.CLAUDE_CONFIG_DIR;
  for (const f of [paths.configJson, paths.usageJson, paths.modelUsageJson, paths.lastSwapJson, paths.accountsJson]) {
    rmSync(f, { force: true });
  }
  rmSync(process.env.TOKENMAXXING_CLAUDE_JSON!, { force: true });
});

afterEach(() => {
  for (const k of MUTATED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(paths.configJson, { force: true });
  rmSync(process.env.TOKENMAXXING_CLAUDE_JSON!, { force: true });
});

describe("pooledSpawnEnv", () => {
  test("scrubs every credential override, presets the depth cap, passes the rest through", () => {
    for (const k of CRED_ENV_OVERRIDES) {
      if (k !== "CLAUDE_SECURESTORAGE_CONFIG_DIR") process.env[k] = "ambient";
    }
    process.env.TOKENMAXXING_SDK_TEST_PASSTHROUGH = "kept";

    const env = pooledSpawnEnv();
    for (const k of CRED_ENV_OVERRIDES) expect(env[k]).toBeUndefined();
    expect(env[WRAP_DEPTH_ENV]).toBe(String(MAX_WRAP_DEPTH));
    expect(env.TOKENMAXXING_SDK_TEST_PASSTHROUGH).toBe("kept");
    // the copy is scrubbed, the ambient process env is not
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient");
  });

  test("fails fast on an ambient config-dir override (swap writes and subprocess reads would desync)", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/somewhere-else";
    expect(() => pooledSpawnEnv()).toThrow(/CLAUDE_CONFIG_DIR is set/);
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/tmp/secure-elsewhere";
    expect(() => pooledSpawnEnv()).toThrow(/CLAUDE_SECURESTORAGE_CONFIG_DIR is set/);
  });
});

describe("pooledOptions", () => {
  test("pins pathToClaudeCodeExecutable to the resolved real claude", () => {
    writeConfig(cfg("/usr/bin/true"));
    expect(claudeExecutablePath()).toBe("/usr/bin/true");
    const opts = pooledOptions();
    expect(opts.pathToClaudeCodeExecutable).toBe("/usr/bin/true");
    expect(opts.env[WRAP_DEPTH_ENV]).toBe(String(MAX_WRAP_DEPTH));
  });

  test("a configured-but-missing claudeBin fails fast instead of PATH-scanning", () => {
    writeConfig(cfg("/nonexistent/claude"));
    expect(() => pooledOptions()).toThrow(/does not exist/);
  });
});

describe("stopHookCheck", () => {
  test("resolves to an empty hook output on a box with no live org", async () => {
    await expect(stopHookCheck()).resolves.toEqual({});
  });

  test("swallows a decision failure that ensureBestAccount surfaces (hook must never interrupt the agent)", async () => {
    // Corrupt claude.json makes readOAuthAccount throw before the engagement
    // pre-check ever short-circuits, exercising the real failure path.
    writeFileSync(process.env.TOKENMAXXING_CLAUDE_JSON!, "{ not json");
    await expect(ensureBestAccount()).rejects.toThrow();
    await expect(stopHookCheck()).resolves.toEqual({});
  });
});
