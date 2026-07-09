import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { readOAuthAccount, swapOAuthAccount, isApiKeyMode } from "../src/lib/claudejson.ts";
import type { OAuthAccount } from "../src/lib/types.ts";

const claudeJson = process.env.TOKENMAXXING_CLAUDE_JSON!;

const seed = () => ({
  numStartups: 42,
  oauthAccount: { accountUuid: "old", emailAddress: "old@e.com", organizationUuid: "org-old", displayName: "Old" },
  projects: { "/x": { foo: 1 } },
  someOtherKey: "keep-me",
});

afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe("claude.json oauthAccount I/O", () => {
  test("readOAuthAccount parses the identity", () => {
    writeFileSync(claudeJson, JSON.stringify(seed()));
    expect(readOAuthAccount()?.emailAddress).toBe("old@e.com");
  });

  test("readOAuthAccount tolerates null descriptive fields (real blobs have them)", () => {
    // real ~/.claude.json carries seatTier:null etc. - must still parse
    writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { accountUuid: "u", emailAddress: "e@e.com", organizationUuid: "o", seatTier: null, billingType: null, displayName: null },
    }));
    expect(readOAuthAccount()?.emailAddress).toBe("e@e.com");
  });

  test("swapOAuthAccount replaces ONLY oauthAccount, preserves other keys", () => {
    writeFileSync(claudeJson, JSON.stringify(seed()));
    const next: OAuthAccount = { accountUuid: "new", emailAddress: "new@e.com", organizationUuid: "org-new" };
    swapOAuthAccount(next);
    const j = JSON.parse(readFileSync(claudeJson, "utf8"));
    expect(j.oauthAccount.accountUuid).toBe("new");
    expect(j.oauthAccount.emailAddress).toBe("new@e.com");
    expect(j.numStartups).toBe(42); // untouched
    expect(j.someOtherKey).toBe("keep-me"); // untouched
    expect(j.projects["/x"].foo).toBe(1); // untouched
  });

  test("isApiKeyMode detects ANTHROPIC_API_KEY", () => {
    writeFileSync(claudeJson, JSON.stringify(seed()));
    expect(isApiKeyMode()).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-xyz";
    expect(isApiKeyMode()).toBe(true);
  });
});
