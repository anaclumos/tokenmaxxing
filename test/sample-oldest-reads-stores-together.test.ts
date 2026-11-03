import { describe, expect, mock, test } from "bun:test";
import { barrier, claudeUsageBody, freshHome, HOUR_MS, installFakeClaude, pooledClaude, serveJson } from "./fixtures.ts";

const home = freshHome();
installFakeClaude(home);
const stub = serveJson([claudeUsageBody(Date.now())]);
process.env.TOKENMAXXING_OAUTH_USAGE_URL = stub.url;

const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const reads = barrier(ids);
const credstore = await import("../src/lib/credstore.ts");
mock.module("../src/lib/credstore.ts", () => ({
  ...credstore,
  readStore: async (accountId: string) => {
    await reads.arrive(accountId);
    return { accessToken: `token-${accountId}`, refreshToken: `refresh-${accountId}`, expiresAt: Date.now() + HOUR_MS, scopes: [], subscriptionType: "max" };
  },
}));

const { claudePool } = await import("../src/lib/paths.ts");
const { loadAccounts, loadConfig, saveAccounts } = await import("../src/lib/state.ts");
const { sampleOldest } = await import("../src/lib/sample.ts");

describe("the periodic sample", () => {
  test("reads the stale batch's credential stores before any read answers, then samples every account in the batch", async () => {
    saveAccounts(claudePool, { version: 2, accounts: ids.map(pooledClaude) });
    try {
      await sampleOldest(loadConfig());
    } finally {
      stub.stop();
    }

    expect(reads.arrived.toSorted()).toEqual(ids.toSorted());
    expect(stub.hits()).toBe(3);
    const accounts = loadAccounts(claudePool).accounts;
    expect(accounts.map((a) => a.windows.some((w) => w.usedPercentage === 20))).toEqual([true, true, true]);
  });
});
