import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { loadAccounts, saveAccounts, loadConfig, loadDepletedWait, loadLastSwapAt, loadUsage, saveDepletedWait, usageTeeAt, writeUsage } from "../src/lib/state.ts";
import { paths } from "../src/lib/paths.ts";
import type { Account, UsageState } from "../src/lib/types.ts";

function acct(): Account {
  return {
    accountUuid: "11111111-2222-3333-4444-555555555555",
    email: "a@e.com",
    organizationUuid: "org-1",
    label: "a@e.com",
    keychainItem: "tokenmaxxing-cred-11111111",
    oauthAccount: { accountUuid: "11111111-2222-3333-4444-555555555555", emailAddress: "a@e.com", organizationUuid: "org-1", extra: "kept" },
    addedAt: new Date(0).toISOString(),
    subscriptionType: "max",
  };
}

describe("config round-trip", () => {
  test("a fully overridden file loads verbatim", () => {
    writeFileSync(paths.configJson, JSON.stringify({ thresholds: { session: 90, weekly: 93 }, claudeBin: "/bin/claude", codexBin: "", policy: { projectionMargin: 3, greedySessionFloor: 40, switchModels: ["fable", "opus"], usagePollTtlMs: 60_000, maxWaitMs: 3_600_000 } }));
    const c = loadConfig();
    expect(c.thresholds).toEqual({ session: 90, weekly: 93 });
    expect(c.policy.projectionMargin).toBe(3);
    expect(c.policy.greedySessionFloor).toBe(40);
    expect(c.policy.switchModels).toEqual(["fable", "opus"]);
    expect(c.policy.usagePollTtlMs).toBe(60_000);
    expect(c.claudeBin).toBe("/bin/claude");
  });
  test("missing config yields defaults", () => {
    expect(loadConfig().thresholds.session).toBeGreaterThan(0);
    expect(loadConfig().thresholds.weekly).toBeGreaterThan(0);
  });
});

describe("accounts round-trip", () => {
  test("save/load preserves accounts + active + loose oauthAccount keys", () => {
    saveAccounts({ version: 1, activeAccountUuid: acct().accountUuid, accounts: [acct()] });
    const idx = loadAccounts();
    expect(idx.accounts.length).toBe(1);
    expect(idx.activeAccountUuid).toBe(acct().accountUuid);
    expect(z.looseObject({ extra: z.string() }).parse(idx.accounts[0]!.oauthAccount).extra).toBe("kept");
  });
});

describe("corrupt state fails loud", () => {
  const withReplaced = (path: string, content: string, fn: () => void) => {
    const prior = existsSync(path) ? readFileSync(path, "utf8") : null;
    writeFileSync(path, content);
    try {
      fn();
    } finally {
      if (prior == null) rmSync(path, { force: true });
      else writeFileSync(path, prior);
    }
  };
  test("unparsable accounts.json throws instead of reading as an empty pool", () => {
    withReplaced(paths.accountsJson, "{ definitely not json", () => {
      expect(() => loadAccounts()).toThrow("refusing to treat a damaged pool as empty");
    });
  });
  test("schema-invalid accounts.json throws too", () => {
    withReplaced(paths.accountsJson, JSON.stringify({ version: 99, accounts: "nope" }), () => {
      expect(() => loadAccounts()).toThrow("does not match the accounts schema");
    });
  });
  test("unparsable config.json throws instead of silently defaulting", () => {
    withReplaced(paths.configJson, "not json either", () => {
      expect(() => loadConfig()).toThrow("corrupt");
    });
  });
  test("corrupt lastswap.json throws instead of silently disabling the cooldown", () => {
    withReplaced(paths.lastSwapJson, "{ not json", () => {
      expect(() => loadLastSwapAt()).toThrow("corrupt");
    });
    rmSync(paths.lastSwapJson, { force: true });
    expect(loadLastSwapAt()).toBe(null);
  });
  test("depleted-wait record round-trips; absent reads null", () => {
    rmSync(paths.depletedJson, { force: true });
    expect(loadDepletedWait()).toBe(null);
    saveDepletedWait({ waitUntil: 123456, accountUuid: "acct-a", ts: 100 });
    expect(loadDepletedWait()).toEqual({ waitUntil: 123456, accountUuid: "acct-a", ts: 100 });
    rmSync(paths.depletedJson, { force: true });
  });
  test("wrong-typed known config keys throw; unknown keys stay tolerated", () => {
    withReplaced(paths.configJson, JSON.stringify({ claudeBin: 42 }), () => {
      expect(() => loadConfig()).toThrow("wrong-typed values (claudeBin)");
    });
    withReplaced(paths.configJson, JSON.stringify({ someFutureKey: true }), () => {
      expect(loadConfig().thresholds.session).toBeGreaterThan(0);
    });
  });
});

describe("usage write-on-change", () => {
  const mk = (pct: number, ts: number): UsageState => ({
    fiveHour: { usedPercentage: pct, resetsAt: 123 },
    sevenDay: { usedPercentage: 10, resetsAt: 456 },
    org: "org-1",
    ts,
    model: null,
  });
  test("writes when values change, skips when only ts differs", () => {
    expect(writeUsage(mk(50, 1))).toBe(true);
    expect(loadUsage()?.fiveHour.usedPercentage).toBe(50);
    expect(writeUsage(mk(50, 999))).toBe(false);
    expect(writeUsage(mk(96, 1000))).toBe(true);
    expect(loadUsage()?.fiveHour.usedPercentage).toBe(96);
  });
  test("a suppressed write still bumps the liveness heartbeat (mtime)", () => {
    const t0 = Date.now();
    expect(writeUsage(mk(70, t0 - 60_000))).toBe(true);
    expect(writeUsage(mk(70, t0))).toBe(false);
    const teeAt = usageTeeAt();
    expect(teeAt).not.toBeNull();
    expect(Math.abs((teeAt ?? 0) - t0)).toBeLessThan(1_000);
  });
});
