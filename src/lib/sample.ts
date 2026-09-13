import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { minBy } from "es-toolkit";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { readStore } from "./credstore.ts";
import { withLock } from "./lock.ts";
import { log } from "./log.ts";
import { claudeTierLabel, isAccessTokenExpiring, isDeadCredential } from "./oauth.ts";
import { claudePool, paths, sampleDirFor, storeDirFor } from "./paths.ts";
import { seatCounts } from "./presence.ts";
import type { Observation } from "./provider.ts";
import { loadAccounts, loadUsageSnapshot, saveAccounts } from "./state.ts";
import { fetchUsageDirect, mergeWindows, probeUsage, windowsOf } from "./usage.ts";
import { UsageWindowsSchema, type Account, type Config } from "./types.ts";

const SampleOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), usage: UsageWindowsSchema }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type SampleOutcome = z.infer<typeof SampleOutcomeSchema>;

const PreparedProbeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), dir: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
type PreparedProbe = z.infer<typeof PreparedProbeSchema>;

export function teeObservation(account: Account): Observation | null {
  const stored = account.lastUsageAt != null ? { windows: account.windows, at: account.lastUsageAt } : null;
  const snap = loadUsageSnapshot(account.id);
  if (!snap) return stored;
  const at = snap.state.sampledAt ?? snap.state.ts;
  if (stored != null && at <= stored.at) return stored;
  const aggregate = windowsOf({ fiveHour: snap.state.fiveHour, sevenDay: snap.state.sevenDay, perModel: {} }, at);
  return { windows: mergeWindows(aggregate, account.windows), at };
}

export function foldTee(account: Account): boolean {
  const observed = teeObservation(account);
  if (!observed || (account.lastUsageAt != null && observed.at <= account.lastUsageAt)) return false;
  account.windows = observed.windows;
  account.lastUsageAt = observed.at;
  return true;
}

export async function prepareProbe(account: Account, suffix = ""): Promise<PreparedProbe> {
  let creds;
  try {
    creds = await readStore(account.id);
  } catch (e) {
    return { ok: false, reason: `store credential unreadable (${(e instanceof Error ? e.message : String(e)).slice(0, 80)}) - run \`tokenmaxxing auth\`` };
  }
  if (!creds) return { ok: false, reason: "no credential in this account's store - run `tokenmaxxing auth`" };
  if (isDeadCredential(creds)) {
    account.needsReauth = true;
    return { ok: false, reason: "the store's credential was cleared after a failed refresh - re-auth with `tokenmaxxing auth`" };
  }
  if (!account.oauthAccount) return { ok: false, reason: "account record has no oauthAccount - run `tokenmaxxing auth`" };
  account.tier = claudeTierLabel(creds) ?? account.tier;
  const dir = sampleDirFor(account.id, suffix);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: account.oauthAccount, hasCompletedOnboarding: true }));
  return { ok: true, dir };
}

export async function runProbe(account: Account, dir: string, opts: { retries?: number }): Promise<SampleOutcome> {
  const usage = await probeUsage({ configDir: dir, store: storeDirFor(account.id) }, Date.now(), { retries: opts.retries });
  return usage ? { ok: true, usage } : { ok: false, reason: "`/usage` returned no limit data (see log)" };
}

export async function probeAccountUsage(account: Account): Promise<SampleOutcome> {
  const prepared = await prepareProbe(account);
  return prepared.ok ? runProbe(account, prepared.dir, {}) : prepared;
}

export async function sampleOldest(cfg: Config): Promise<void> {
  const reserved = await withLock(claudePool.lockFile, async () => {
    const now = Date.now();
    const idx = loadAccounts(claudePool);
    let dirty = false;
    for (const a of idx.accounts) dirty = foldTee(a) || dirty;
    const sampledAt = (a: Account) => Math.max(a.lastUsageAt ?? 0, a.lastProbeAt ?? 0);
    const stale = idx.accounts.filter((a) => a.needsReauth !== true && now - sampledAt(a) > cfg.policy.usagePollTtlMs);
    const target = minBy(stale, sampledAt);
    if (!target) {
      if (dirty) saveAccounts(claudePool, idx);
      return null;
    }
    target.lastProbeAt = now;
    const prepared = await prepareProbe(target, "-tick");
    saveAccounts(claudePool, idx);
    if (!prepared.ok) {
      log("sample.failed", { account: target.id.slice(0, 8), reason: prepared.reason.slice(0, 200) });
      return null;
    }
    let token: string | null = null;
    if (!seatCounts(paths.presenceDir).has(target.id)) {
      const creds = await readStore(target.id).catch(() => null);
      if (creds && !isDeadCredential(creds) && !isAccessTokenExpiring(creds)) token = creds.accessToken;
    }
    return { account: target, dir: prepared.dir, token };
  });
  if (!reserved) return;
  const startedAt = Date.now();
  let via = "probe";
  let outcome: SampleOutcome;
  if (reserved.token) {
    const usage = await fetchUsageDirect(reserved.token);
    if (usage) {
      via = "get";
      outcome = { ok: true, usage };
    } else {
      outcome = await runProbe(reserved.account, reserved.dir, { retries: 0 });
    }
  } else {
    outcome = await runProbe(reserved.account, reserved.dir, { retries: 0 });
  }
  await withLock(claudePool.lockFile, () => {
    const idx = loadAccounts(claudePool);
    const stored = idx.accounts.find((a) => a.id === reserved.account.id);
    if (stored && outcome.ok && (stored.lastUsageAt == null || startedAt > stored.lastUsageAt)) {
      stored.windows = mergeWindows(windowsOf(outcome.usage, startedAt), stored.windows);
      stored.lastUsageAt = startedAt;
      saveAccounts(claudePool, idx);
    }
    log(outcome.ok ? "sample.ok" : "sample.failed", {
      account: reserved.account.id.slice(0, 8),
      ...(outcome.ok ? { via } : { reason: outcome.reason.slice(0, 200) }),
    });
  });
}
