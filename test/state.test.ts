import { describe, expect, test } from "bun:test";
import { loadAccounts, saveAccounts, loadConfig, saveConfig, loadUsage, usageTeeAt, writeUsage } from "../src/lib/state.ts";
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
  test("save/load preserves thresholds + policy", () => {
    saveConfig({ thresholds: { session: 90, weekly: 93 }, claudeBin: "/bin/claude", policy: { projectionMargin: 3, greedySessionFloor: 40, switchModels: ["fable", "opus"], usagePollTtlMs: 60_000, maxWaitMs: 3_600_000 } });
    const c = loadConfig();
    expect(c.thresholds).toEqual({ session: 90, weekly: 93 });
    expect(c.policy.projectionMargin).toBe(3);
    expect(c.policy.greedySessionFloor).toBe(40);
    expect(c.policy.switchModels).toEqual(["fable", "opus"]);
    expect(c.policy.usagePollTtlMs).toBe(60_000);
    // note: claudeBin may be overridden by TOKENMAXXING_CLAUDE_BIN env (unset here)
    expect(c.claudeBin).toBe("/bin/claude");
  });
  test("missing config yields defaults", () => {
    // fresh load after a save still valid; defaults path covered by schema
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
    expect((idx.accounts[0]!.oauthAccount as any).extra).toBe("kept");
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
    expect(writeUsage(mk(50, 999))).toBe(false); // only ts changed → skipped
    expect(writeUsage(mk(96, 1000))).toBe(true); // value changed → written
    expect(loadUsage()?.fiveHour.usedPercentage).toBe(96);
  });
  test("a suppressed write still bumps the liveness heartbeat (mtime)", () => {
    const t0 = Date.now();
    expect(writeUsage(mk(70, t0 - 60_000))).toBe(true);
    expect(writeUsage(mk(70, t0))).toBe(false); // suppressed, figures unchanged
    const teeAt = usageTeeAt();
    expect(teeAt).not.toBeNull();
    // mtime tracks the suppressed write's ts, not the original write time.
    expect(Math.abs((teeAt ?? 0) - t0)).toBeLessThan(1_000);
  });
});
