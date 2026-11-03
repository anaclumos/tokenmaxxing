import { describe, expect, mock, spyOn, test } from "bun:test";
import { barrier, freshHome, HOUR_MS, pooledClaude } from "./fixtures.ts";

freshHome();

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
const { saveAccounts } = await import("../src/lib/state.ts");
const { claude } = await import("../src/lib/claude.ts");
const { cmdAuth } = await import("../src/cli/auth.ts");

describe("auth --all", () => {
  test("checks every account's store before any check answers, and finds nothing to reauthenticate when all are usable", async () => {
    saveAccounts(claudePool, { version: 2, accounts: ids.map(pooledClaude) });
    const printed: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    let code: number;
    try {
      code = await cmdAuth(claude, ["--all"], null);
    } finally {
      log.mockRestore();
    }

    expect(code).toBe(0);
    expect(reads.arrived.toSorted()).toEqual(ids.toSorted());
    expect(printed.some((line) => line.includes("every account has a usable credential"))).toBe(true);
  });
});
