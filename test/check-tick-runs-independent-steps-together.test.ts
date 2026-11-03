import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { account, claudeCredentials, claudeUsageBody, freshHome, HOUR_MS, installFakeClaude, pooledClaude, serveTogether, weeklyWindow } from "./fixtures.ts";

const home = freshHome();
installFakeClaude(home);
delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;

const now = Date.now();
const usagePath = "/claude/usage";
const resetPath = "/codex/reset";
const creditPath = "/openrouter/v1/key";
const bodies: Record<string, unknown> = {
  [usagePath]: claudeUsageBody(now),
  [resetPath]: { code: "reset" },
  [creditPath]: { data: { limit_remaining: 7 } },
};
const stub = serveTogether({ keys: [usagePath, resetPath, creditPath], respond: (req) => bodies[new URL(req.url).pathname] ?? {} });
process.env.TOKENMAXXING_OAUTH_USAGE_URL = `${stub.base}${usagePath}`;
process.env.TOKENMAXXING_CODEX_RESET_URL = `${stub.base}${resetPath}`;
process.env.TOKENMAXXING_OPENROUTER_URL = `${stub.base}/openrouter`;

const { claudePool, codexPool, codexAuthJsonFor, storeDirFor } = await import("../src/lib/paths.ts");
const { loadAccounts, saveAccounts } = await import("../src/lib/state.ts");
const { apiKeySecretFor, loadApiKeys, saveApiKeys } = await import("../src/lib/apikeys.ts");
const { cmdCheck } = await import("../src/cli/check.ts");

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
}

describe("the check tick", () => {
  test("starts the Claude sample, the Codex banked reset, and the OpenRouter credit read before any of them answers, and lands all three", async () => {
    const claudeId = crypto.randomUUID();
    saveAccounts(claudePool, { version: 2, accounts: [pooledClaude(claudeId)] });
    writeFile(join(storeDirFor(claudeId), ".credentials.json"), claudeCredentials(`claude-${claudeId}`, now + HOUR_MS));

    const codexId = crypto.randomUUID();
    const codexAccount = { ...account(codexId, "plus", [weeklyWindow(99, now + 5 * 24 * HOUR_MS, now)]), lastUsageAt: now, bankedReset: { grant: null } };
    saveAccounts(codexPool, { version: 2, accounts: [codexAccount] });
    const idToken = jwt({ email: "codex@example.com", "https://api.openai.com/auth": { chatgpt_user_id: "user-1", chatgpt_account_id: "acct-1" } });
    const tokens = { id_token: idToken, access_token: jwt({ exp: Math.floor(now / 1000) + 3600 }), refresh_token: "codex-refresh" };
    writeFile(codexAuthJsonFor(codexId), JSON.stringify({ tokens }));

    saveApiKeys({ version: 1, keys: [{ id: "router", label: "router", spentUsd: 0, creditSetAt: now, addedAt: now }], baselines: {} });
    writeFile(apiKeySecretFor("router"), "sk-or-test-key\n");

    try {
      expect(await cmdCheck(true)).toBe(0);
    } finally {
      stub.stop();
    }

    expect(stub.arrived.toSorted()).toEqual([creditPath, resetPath, usagePath].toSorted());
    const claude = loadAccounts(claudePool).accounts.find((a) => a.id === claudeId);
    expect(typeof claude?.lastUsageAt).toBe("number");
    expect(claude?.windows.some((w) => w.usedPercentage === 20)).toBe(true);
    const codex = loadAccounts(codexPool).accounts.find((a) => a.id === codexId);
    expect(codex?.bankedReset).toBeUndefined();
    expect(codex?.windows).toEqual([]);
    expect(loadApiKeys().keys.find((k) => k.id === "router")?.openrouter?.remainingUsd).toBe(7);
  });
});
