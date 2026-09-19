import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { readStore } from "./credstore.ts";
import { withLock } from "./lock.ts";
import { errorMessage, log } from "./log.ts";
import { claudeTierLabel, isAccessTokenExpiring, isDeadCredential } from "./oauth.ts";
import { claudePool, paths, sampleDirFor, storeDirFor } from "./paths.ts";
import { seatCounts } from "./presence.ts";
import type { Observation } from "./provider.ts";
import { loadAccounts, loadUsageSnapshot, saveAccounts } from "./state.ts";
import { fetchUsageDirect, mergeWindows, refreshViaProbe, windowsOf } from "./usage.ts";
import type { Account, Config, UsageWindows } from "./types.ts";

export type SampleOutcome = { ok: true; usage: UsageWindows; via: "get" | "probe" } | { ok: false; reason: string };

type PreparedSample = { ok: true; token: string | null } | { ok: false; reason: string };

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

export async function prepareSample(account: Account): Promise<PreparedSample> {
  let creds;
  try {
    creds = await readStore(account.id);
  } catch (e) {
    return { ok: false, reason: `store credential unreadable (${errorMessage(e).slice(0, 80)}) - run \`tokenmaxxing auth\`` };
  }
  if (!creds) return { ok: false, reason: "no credential in this account's store - run `tokenmaxxing auth`" };
  if (isDeadCredential(creds)) {
    account.needsReauth = true;
    return { ok: false, reason: "the store's credential was cleared after a failed refresh - re-auth with `tokenmaxxing auth`" };
  }
  if (!account.oauthAccount) return { ok: false, reason: "account record has no oauthAccount - run `tokenmaxxing auth`" };
  account.tier = claudeTierLabel(creds) ?? account.tier;
  return { ok: true, token: isAccessTokenExpiring(creds) ? null : creds.accessToken };
}

async function refreshedToken(account: Account, suffix: string): Promise<string | null> {
  const dir = sampleDirFor(account.id, suffix);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: account.oauthAccount, hasCompletedOnboarding: true }));
  if (!(await refreshViaProbe({ configDir: dir, store: storeDirFor(account.id) }))) return null;
  const prepared = await prepareSample(account);
  return prepared.ok ? prepared.token : null;
}

export async function runSample(account: Account, token: string | null, suffix = ""): Promise<SampleOutcome> {
  if (token) {
    const usage = await fetchUsageDirect(token);
    if (usage) return { ok: true, usage, via: "get" };
  }
  const fresh = await refreshedToken(account, suffix);
  if (!fresh) return { ok: false, reason: "the `/usage` probe left no usable access token in the store (see log)" };
  const usage = await fetchUsageDirect(fresh);
  return usage ? { ok: true, usage, via: "probe" } : { ok: false, reason: "usage read failed after the `/usage` probe (see log)" };
}

export async function sampleAccountUsage(account: Account): Promise<SampleOutcome> {
  const prepared = await prepareSample(account);
  return prepared.ok ? runSample(account, prepared.token) : prepared;
}

const SAMPLE_BATCH = 3;
const STORE_FAILS_REAUTH = 5;

export async function sampleOldest(cfg: Config): Promise<void> {
  const reserved = await withLock(claudePool.lockFile, async () => {
    const now = Date.now();
    const idx = loadAccounts(claudePool);
    let dirty = false;
    for (const a of idx.accounts) dirty = foldTee(a) || dirty;
    const sampledAt = (a: Account) => Math.max(a.lastUsageAt ?? 0, a.lastProbeAt ?? 0);
    const seats = seatCounts(paths.presenceDir);
    const stale = idx.accounts
      .filter((a) => a.needsReauth !== true && now - sampledAt(a) > cfg.policy.usagePollTtlMs)
      .sort((a, b) => Number(seats.has(b.id)) - Number(seats.has(a.id)) || sampledAt(a) - sampledAt(b))
      .slice(0, SAMPLE_BATCH);
    if (stale.length === 0) {
      if (dirty) saveAccounts(claudePool, idx);
      return [];
    }
    const batch: { account: Account; token: string | null }[] = [];
    for (const target of stale) {
      target.lastProbeAt = now;
      const prepared = await prepareSample(target);
      if (!prepared.ok) {
        target.storeFails = (target.storeFails ?? 0) + 1;
        if (target.storeFails >= STORE_FAILS_REAUTH) target.needsReauth = true;
        log("sample.failed", { account: target.id.slice(0, 8), reason: prepared.reason.slice(0, 200) });
        continue;
      }
      target.storeFails = 0;
      batch.push({ account: target, token: prepared.token });
    }
    saveAccounts(claudePool, idx);
    return batch;
  });
  await Promise.all(
    reserved.map(async ({ account, token }) => {
      const startedAt = Date.now();
      const outcome = await runSample(account, token, "-tick");
      await withLock(claudePool.lockFile, () => {
        const idx = loadAccounts(claudePool);
        const stored = idx.accounts.find((a) => a.id === account.id);
        let dirty = false;
        if (stored && account.needsReauth === true && stored.needsReauth !== true) {
          stored.needsReauth = true;
          dirty = true;
        }
        if (stored && outcome.ok && (stored.lastUsageAt == null || startedAt > stored.lastUsageAt)) {
          stored.windows = mergeWindows(windowsOf(outcome.usage, startedAt), stored.windows);
          stored.lastUsageAt = startedAt;
          dirty = true;
        }
        if (dirty) saveAccounts(claudePool, idx);
        log(outcome.ok ? "sample.ok" : "sample.failed", {
          account: account.id.slice(0, 8),
          ...(outcome.ok ? { via: outcome.via } : { reason: outcome.reason.slice(0, 200) }),
        });
      });
    }),
  );
}
