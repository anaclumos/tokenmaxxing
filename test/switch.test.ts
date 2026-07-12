// The idempotent no-op paths of bare `tokenmaxxing switch`: they must decide
// entirely off accounts.json + ~/.claude.json (never touching the credential
// store), so they run hermetically here. Paths that actually swap are covered
// by the e2e suite.

import { writeFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";
import { cmdSwitch } from "../src/cli/switch.ts";
import { loadAccounts, saveAccounts } from "../src/lib/state.ts";
import type { Account, UsageWindows } from "../src/lib/types.ts";

const H = 3_600_000;
const D = 24 * H;

function acct(uuid: string, lastUsage?: UsageWindows): Account {
  return {
    accountUuid: uuid,
    email: `${uuid}@e.com`,
    organizationUuid: `org-${uuid}`,
    label: uuid,
    keychainItem: `tokenmaxxing-cred-${uuid}`,
    oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@e.com`, organizationUuid: `org-${uuid}` },
    addedAt: new Date(0).toISOString(),
    lastUsage,
    lastUsageAt: lastUsage ? Date.now() : undefined,
  };
}

/** Pin the live-login identity to the labeled active account (no drift). */
function claudeJsonNames(uuid: string) {
  writeFileSync(
    process.env.TOKENMAXXING_CLAUDE_JSON!,
    JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@e.com`, organizationUuid: `org-${uuid}` } }),
  );
}

describe("cmdSwitch idempotence", () => {
  beforeEach(() => claudeJsonNames("cur"));

  test("no-ops when the current account is already the best choice", async () => {
    const now = Date.now();
    const cur = acct("cur", { fiveHour: { usedPercentage: 10, resetsAt: now + H }, sevenDay: { usedPercentage: 40, resetsAt: now + D } });
    const other = acct("other", { fiveHour: { usedPercentage: 10, resetsAt: now + H }, sevenDay: { usedPercentage: 10, resetsAt: now + 5 * D } });
    saveAccounts({ version: 1, activeAccountUuid: "cur", accounts: [cur, other] });
    expect(await cmdSwitch()).toBe(0);
    expect(loadAccounts().activeAccountUuid).toBe("cur");
  });

  test("no-ops on an exact tie even when the tied rival sorts first", async () => {
    // both unsampled: weekly expiry Infinity, weekly usage 0 - a dead tie.
    saveAccounts({ version: 1, activeAccountUuid: "cur", accounts: [acct("other"), acct("cur")] });
    expect(await cmdSwitch()).toBe(0);
    expect(loadAccounts().activeAccountUuid).toBe("cur");
  });

  test("stays put when all are depleted and the current account recovers soonest", async () => {
    const now = Date.now();
    const cur = acct("cur", { fiveHour: { usedPercentage: 99, resetsAt: now + H }, sevenDay: { usedPercentage: 10, resetsAt: now + 2 * D } });
    const other = acct("other", { fiveHour: { usedPercentage: 99, resetsAt: now + 3 * H }, sevenDay: { usedPercentage: 10, resetsAt: now + 5 * D } });
    saveAccounts({ version: 1, activeAccountUuid: "cur", accounts: [cur, other] });
    expect(await cmdSwitch()).toBe(0);
    expect(loadAccounts().activeAccountUuid).toBe("cur");
  });

  test("no-ops when the sooner-expiring rival's Fable cap is burnt (default switchModels)", async () => {
    const now = Date.now();
    const cur = acct("cur", { fiveHour: { usedPercentage: 10, resetsAt: now + H }, sevenDay: { usedPercentage: 40, resetsAt: now + 5 * D } });
    const rival = {
      ...acct("other", { fiveHour: { usedPercentage: 10, resetsAt: now + H }, sevenDay: { usedPercentage: 20, resetsAt: now + D } }),
      lastPerModel: { Fable: { usedPercentage: 97, resetsAt: now + D } },
    };
    saveAccounts({ version: 1, activeAccountUuid: "cur", accounts: [cur, rival] });
    expect(await cmdSwitch()).toBe(0);
    expect(loadAccounts().activeAccountUuid).toBe("cur");
  });

  test("stays put (exit 0) when current is at limit and the only rival needs re-auth", async () => {
    const now = Date.now();
    const cur = acct("cur", { fiveHour: { usedPercentage: 99, resetsAt: now + H }, sevenDay: { usedPercentage: 40, resetsAt: now + 6 * D } });
    const other = { ...acct("other", { fiveHour: { usedPercentage: 5, resetsAt: now + H }, sevenDay: { usedPercentage: 5, resetsAt: now + D } }), needsReauth: true };
    saveAccounts({ version: 1, activeAccountUuid: "cur", accounts: [cur, other] });
    expect(await cmdSwitch()).toBe(0);
    expect(loadAccounts().activeAccountUuid).toBe("cur");
  });
});
