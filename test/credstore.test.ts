import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readItem, writeItem, deleteItem,
  liveTarget, parkedTarget, isolatedTarget,
  claudeAiOauthOnly, mergeIntoLive,
  type CredTarget,
} from "../src/lib/credstore.ts";
import { credDir, paths } from "../src/lib/paths.ts";

const base = globalThis.__TM_TEST_BASE__!;

describe("file-backend I/O", () => {
  const target: CredTarget = { kind: "file", path: join(base, "credfiles", "t.json") };
  const blob = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01_AbC-dEf_12/34+xyz==",
      refreshToken: "sk-ant-ort01_Zz9-Yy8_qwe",
      expiresAt: 1799999999000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
    },
  });

  test("write → read → update → delete round-trips byte-exact", async () => {
    expect(await readItem(target)).toBe(null);
    await writeItem(target, blob);
    expect(await readItem(target)).toBe(blob);
    expect(statSync(target.path).mode & 0o777).toBe(0o600);

    const blob2 = blob.replace("max", "pro");
    await writeItem(target, blob2);
    expect(await readItem(target)).toBe(blob2);

    expect(await deleteItem(target)).toBe(true);
    expect(await readItem(target)).toBe(null);
    expect(await deleteItem(target)).toBe(false);
  });
});

describe("target resolution", () => {
  const linuxOnly = process.platform === "linux" ? test : test.skip;
  const darwinOnly = process.platform === "darwin" ? test : test.skip;

  linuxOnly("live/parked/isolated resolve to the claude + tokenmaxxing files", () => {
    expect(liveTarget()).toEqual({ kind: "file", path: join(paths.claudeDir, ".credentials.json") });
    expect(parkedTarget("tokenmaxxing-cred-abcd1234")).toEqual({
      kind: "file",
      path: join(paths.credsDir, "tokenmaxxing-cred-abcd1234.json"),
    });
    expect(isolatedTarget("/tmp/onboard-x")).toEqual({ kind: "file", path: "/tmp/onboard-x/.credentials.json" });
  });

  darwinOnly("live/parked/isolated resolve to keychain services", () => {
    // setup.ts sandboxes the service/account (the suite must never touch the
    // real `Claude Code-credentials` item); the target follows those knobs.
    expect(liveTarget()).toEqual({
      kind: "keychain",
      service: `tokenmaxxing-test-${process.pid}`,
      account: "tokenmaxxing-test",
    });
    expect(parkedTarget("tokenmaxxing-cred-abcd1234")).toMatchObject({ kind: "keychain", service: "tokenmaxxing-cred-abcd1234" });
    expect(isolatedTarget("/tmp/onboard-x")).toMatchObject({ kind: "keychain" });
    const iso = isolatedTarget("/tmp/onboard-x");
    if (iso.kind === "keychain") expect(iso.service).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  });

  test("credDir honors CLAUDE_SECURESTORAGE_CONFIG_DIR first, like claude does", () => {
    const prev = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    try {
      process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/x/secure";
      expect(credDir()).toBe("/x/secure");
      process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = ""; // defined-but-empty → ~/.claude
      expect(credDir()).toBe(join(homedir(), ".claude"));
      delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      expect(credDir()).toBe(paths.claudeDir);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      else process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = prev;
    }
  });
});

describe("credential blob helpers", () => {
  const full = JSON.stringify({
    claudeAiOauth: { accessToken: "A", refreshToken: "R", expiresAt: 1, scopes: [] },
    mcpOAuth: { sentry: { accessToken: "keep-me" } },
    extra: 42,
  });
  test("claudeAiOauthOnly reduces to just claudeAiOauth", () => {
    const only = JSON.parse(claudeAiOauthOnly(full));
    expect(Object.keys(only)).toEqual(["claudeAiOauth"]);
    expect(only.claudeAiOauth.accessToken).toBe("A");
  });
  test("mergeIntoLive swaps claudeAiOauth but preserves every sibling key", () => {
    const merged = JSON.parse(mergeIntoLive(full, { accessToken: "NEW", refreshToken: "NR", expiresAt: 9, scopes: [] }));
    expect(merged.claudeAiOauth.accessToken).toBe("NEW");
    expect(merged.mcpOAuth.sentry.accessToken).toBe("keep-me"); // preserved
    expect(merged.extra).toBe(42); // preserved
  });
  test("mergeIntoLive handles a null/empty current blob", () => {
    const merged = JSON.parse(mergeIntoLive(null, { accessToken: "X", refreshToken: "Y", expiresAt: 1, scopes: [] }));
    expect(merged.claudeAiOauth.accessToken).toBe("X");
  });
});
