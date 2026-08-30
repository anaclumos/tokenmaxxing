import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { delay } from "es-toolkit";
import { withClaudeRefreshLock } from "../src/lib/claudelock.ts";
import { credDir } from "../src/lib/paths.ts";

const dir = credDir();
mkdirSync(dir, { recursive: true });
const primary = join(dir, ".oauth_refresh.lock");
const legacy = `${realpathSync(dir)}.lock`;

const fast = { attempts: 2, retryMs: 5 };

afterEach(() => {
  for (const d of [primary, legacy]) {
    try { rmdirSync(d); } catch {  }
  }
});

test("takes both locks around fn and releases them after", async () => {
  let sawPrimary = false;
  let sawLegacy = false;
  const out = await withClaudeRefreshLock(() => {
    sawPrimary = existsSync(primary);
    sawLegacy = existsSync(legacy);
    return 42;
  }, fast);
  expect(out).toBe(42);
  expect(sawPrimary).toBe(true);
  expect(sawLegacy).toBe(true);
  expect(existsSync(primary)).toBe(false);
  expect(existsSync(legacy)).toBe(false);
});

test("fails fast when the primary lock is contested", async () => {
  mkdirSync(primary);
  let ran = false;
  await expect(withClaudeRefreshLock(() => { ran = true; }, fast)).rejects.toThrow("contested");
  expect(ran).toBe(false);
  expect(existsSync(legacy)).toBe(false);
});

test("fails fast when the legacy lock is contested, releasing the primary", async () => {
  mkdirSync(legacy);
  let ran = false;
  await expect(withClaudeRefreshLock(() => { ran = true; }, fast)).rejects.toThrow("contested");
  expect(ran).toBe(false);
  expect(existsSync(primary)).toBe(false);
});

test("reclaims a lock older than claude's 60s stale bar", async () => {
  mkdirSync(primary);
  const old = new Date(Date.now() - 61_000);
  utimesSync(primary, old, old);
  const out = await withClaudeRefreshLock(() => "ran", fast);
  expect(out).toBe("ran");
  expect(existsSync(primary)).toBe(false);
});

test("theft while held is detected, fails the section, and spares the thief's lock", async () => {
  await expect(
    withClaudeRefreshLock(async (lock) => {
      rmdirSync(primary);
      mkdirSync(primary);
      const theirs = new Date(Date.now() + 1_000);
      utimesSync(primary, theirs, theirs);
      await delay(60);
      expect(lock.compromised()).toBe(true);
      return "tainted";
    }, { ...fast, heartbeatMs: 10 }),
  ).rejects.toThrow("reclaimed");
  expect(existsSync(primary)).toBe(true);
});
