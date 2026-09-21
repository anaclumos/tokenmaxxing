import { readStore } from "./credstore.ts";
import { withLock } from "./lock.ts";
import { errorMessage, log } from "./log.ts";
import { claudeTierLabel, isDeadCredential } from "./oauth.ts";
import { claudePool, paths } from "./paths.ts";
import { seatCounts } from "./presence.ts";
import type { Observation } from "./provider.ts";
import { loadAccounts, loadUsageSnapshot, saveAccounts } from "./state.ts";
import { fetchUsageDirect, mergeWindows, windowsOf } from "./usage.ts";
import type { Account, Config, UsageWindows } from "./types.ts";

export type SampleOutcome = { ok: true; usage: UsageWindows; via: "get" } | { ok: false; reason: string; retryAt?: number };

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
  return { ok: true, token: creds.accessToken };
}

export function usageBlockedUntil(account: Account, now: number): number | null {
  return account.usageRetryAt != null && account.usageRetryAt > now ? account.usageRetryAt : null;
}

function rateLimitedReason(retryAt: number, now: number): string {
  return `the usage endpoint rate limited this account, next read in ${Math.ceil((retryAt - now) / 60_000)}m`;
}

export async function runSample(account: Account, token: string | null): Promise<SampleOutcome> {
  if (!token) return { ok: false, reason: "no usable access token in the store - run `tokenmaxxing auth`" };
  const read = await fetchUsageDirect(token);
  if (read.ok) return { ok: true, usage: read.usage, via: "get" };
  if (read.retryAt == null) return { ok: false, reason: "usage read failed (see log)" };
  return { ok: false, reason: rateLimitedReason(read.retryAt, Date.now()), retryAt: read.retryAt };
}

export async function sampleAccountUsage(account: Account): Promise<SampleOutcome> {
  const now = Date.now();
  const blockedUntil = usageBlockedUntil(account, now);
  if (blockedUntil != null) return { ok: false, reason: rateLimitedReason(blockedUntil, now) };
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
      .filter((a) => a.needsReauth !== true && usageBlockedUntil(a, now) == null && now - sampledAt(a) > cfg.policy.usagePollTtlMs)
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
      const outcome = await runSample(account, token);
      await withLock(claudePool.lockFile, () => {
        const idx = loadAccounts(claudePool);
        const stored = idx.accounts.find((a) => a.id === account.id);
        let dirty = false;
        if (stored && account.needsReauth === true && stored.needsReauth !== true) {
          stored.needsReauth = true;
          dirty = true;
        }
        if (stored && !outcome.ok && outcome.retryAt != null) {
          stored.usageRetryAt = outcome.retryAt;
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
