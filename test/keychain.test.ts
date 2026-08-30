import { afterAll, describe, expect, test } from "bun:test";
import { readItem, writeItem, deleteItem } from "../src/lib/keychain.ts";

const it = process.platform === "darwin" ? test : test.skip;

describe("keychain ps-safe I/O", () => {
  const target = { service: `tokenmaxxing-test-${process.pid}`, account: process.env.USER ?? "unknown" };
  const bigTarget = { service: `tokenmaxxing-test-big-${process.pid}`, account: process.env.USER ?? "unknown" };

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
    await writeItem(target, blob2);
    expect(await readItem(target)).toBe(blob2);

    expect(await deleteItem(target)).toBe(true);
    expect(await readItem(target)).toBe(null);
  });

  it("round-trips a >4KB blob byte-exact (argv fallback path)", async () => {
    const big = JSON.stringify({
      claudeAiOauth: { accessToken: "a".repeat(108), refreshToken: "r".repeat(108), expiresAt: 1799999999000, scopes: ["user:inference"] },
      mcpOAuth: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`srv${i}`, { accessToken: "t".repeat(300), redirectUri: "http://localhost:3118/callback?utm_source=plugin" }])),
    });
    expect(big.length).toBeGreaterThan(4096);
    await writeItem(bigTarget, big);
    expect(await readItem(bigTarget)).toBe(big);
    await deleteItem(bigTarget);
  });

  it("round-trips a quote-dense apostrophe blob whose EXPANDED line exceeds the interactive buffer", async () => {
    let body = "";
    while (body.length < 3660) body += '"k":"v",';
    const dense = `{'${body}}`;
    expect(dense.length).toBeLessThan(3800);
    await writeItem(bigTarget, dense);
    expect(await readItem(bigTarget)).toBe(dense);
    await deleteItem(bigTarget);
  });
});
