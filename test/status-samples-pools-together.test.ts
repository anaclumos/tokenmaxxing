import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { account, claudeCredentials, claudeUsageBody, freshHome, HOUR_MS, installFakeClaude, pooledClaude, serveTogether } from "./fixtures.ts";

const home = freshHome();
installFakeClaude(home);
delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;

const now = Date.now();
const claudePath = "/claude/usage";
const grokPath = "/grok/billing";
const cursorPath = "/cursor/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const bodies: Record<string, unknown> = {
  [claudePath]: claudeUsageBody(now),
  [grokPath]: { config: { currentPeriod: { start: new Date(now - 24 * HOUR_MS).toISOString(), end: new Date(now + 6 * 24 * HOUR_MS).toISOString() }, creditUsagePercent: 12 } },
  [cursorPath]: { billingCycleStart: now - 24 * HOUR_MS, billingCycleEnd: now + 20 * 24 * HOUR_MS, planUsage: { totalPercentUsed: 33 } },
};
const stub = serveTogether({ keys: [claudePath, grokPath, cursorPath], respond: (req) => bodies[new URL(req.url).pathname] ?? {} });
process.env.TOKENMAXXING_OAUTH_USAGE_URL = `${stub.base}${claudePath}`;
process.env.TOKENMAXXING_GROK_USAGE_URL = `${stub.base}${grokPath}`;
process.env.TOKENMAXXING_CURSOR_API_URL = `${stub.base}/cursor`;

const { claudePool, cursorAuthJsonFor, cursorPool, grokAuthJsonFor, grokPool, storeDirFor } = await import("../src/lib/paths.ts");
const { loadAccounts, saveAccounts } = await import("../src/lib/state.ts");
const { cmdStatus } = await import("../src/cli/status.ts");

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
}

describe("status", () => {
  test("samples every pool before any pool's read answers, and stores each pool's figures", async () => {
    const claudeId = crypto.randomUUID();
    saveAccounts(claudePool, { version: 2, accounts: [pooledClaude(claudeId)] });
    writeFile(join(storeDirFor(claudeId), ".credentials.json"), claudeCredentials(`claude-${claudeId}`, now + HOUR_MS));

    const grokId = crypto.randomUUID();
    saveAccounts(grokPool, { version: 2, accounts: [account(grokId, "supergrok", [])] });
    writeFile(grokAuthJsonFor(grokId), JSON.stringify({ [grokId]: { user_id: grokId, key: "grok-token", refresh_token: "grok-refresh" } }));

    const cursorId = crypto.randomUUID();
    saveAccounts(cursorPool, { version: 2, accounts: [account(cursorId, "pro", [])] });
    writeFile(cursorAuthJsonFor(cursorId), JSON.stringify({ accessToken: "cursor-token" }));

    try {
      expect(await cmdStatus({ json: true })).toBe(0);
    } finally {
      stub.stop();
    }

    expect(stub.arrived).toEqual(expect.arrayContaining([claudePath, grokPath, cursorPath]));
    const claude = loadAccounts(claudePool).accounts.find((a) => a.id === claudeId);
    expect(claude?.windows.some((w) => w.usedPercentage === 20)).toBe(true);
    expect(loadAccounts(grokPool).accounts.find((a) => a.id === grokId)?.windows[0]?.usedPercentage).toBe(12);
    expect(loadAccounts(cursorPool).accounts.find((a) => a.id === cursorId)?.windows[0]?.usedPercentage).toBe(33);
  });
});
