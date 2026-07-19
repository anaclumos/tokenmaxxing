import { afterAll, describe, expect, test } from "bun:test";
import { readItem, writeItem, deleteItem } from "../src/lib/keychain.ts";

// keychain is macOS-only; skip elsewhere. Uses a throwaway service, never the
// real "Claude Code-credentials" item.
const it = process.platform === "darwin" ? test : test.skip;

describe("keychain ps-safe I/O", () => {
  const target = { service: `tokenmaxxing-test-${process.pid}`, account: process.env.USER ?? "unknown" };
  const bigTarget = { service: `tokenmaxxing-test-big-${process.pid}`, account: process.env.USER ?? "unknown" };

  // The items live in the REAL login keychain, and the pid-unique names mean
  // no later run ever reaps them: an assertion failing before the inline
  // deleteItem would strand them forever (closing-review catch). afterAll
  // deletes unconditionally; deleteItem on an already-removed item is a no-op.
  afterAll(async () => {
    if (process.platform !== "darwin") return;
    await deleteItem(target);
    await deleteItem(bigTarget);
  });
  const blob = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01_AbC-dEf_12/34+xyz==",
      refreshToken: "sk-ant-ort01_Zz9-Yy8_qwe",
      expiresAt: 1799999999000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
    },
  });

  it("write → read → update → delete round-trips byte-exact", async () => {
    expect(await readItem(target)).toBe(null);
    await writeItem(target, blob);
    expect(await readItem(target)).toBe(blob);

    const blob2 = blob.replace("max", "pro");
    await writeItem(target, blob2); // -U update in place
    expect(await readItem(target)).toBe(blob2);

    expect(await deleteItem(target)).toBe(true);
    expect(await readItem(target)).toBe(null);
  });

  it("round-trips a >4KB blob byte-exact (argv fallback path)", async () => {
    // mimics a real live blob bloated with MCP OAuth state - over security -i's limit
    const big = JSON.stringify({
      claudeAiOauth: { accessToken: "a".repeat(108), refreshToken: "r".repeat(108), expiresAt: 1799999999000, scopes: ["user:inference"] },
      mcpOAuth: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`srv${i}`, { accessToken: "t".repeat(300), redirectUri: "http://localhost:3118/callback?utm_source=plugin" }])),
    });
    expect(big.length).toBeGreaterThan(4096);
    await writeItem(bigTarget, big);
    expect(await readItem(bigTarget)).toBe(big);
    await deleteItem(bigTarget);
  });
});
