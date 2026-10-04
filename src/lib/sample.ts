import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_BIN, MAX_WRAP_DEPTH, resolveRealBin, WRAP_DEPTH_ENV } from "./claudebin.ts";
import { deleteItem, readStore, storeTarget } from "./credstore.ts";
import { withLock } from "./lock.ts";
import { errorMessage, log } from "./log.ts";
import { claudeTierLabel, isDeadCredential } from "./oauth.ts";
import { claudePool, paths, storeDirFor } from "./paths.ts";
import { barFor, gatedWindows, landWindows, liveUsed, thresholdBars } from "./picker.ts";
import { seatCounts } from "./presence.ts";
import type { Observation } from "./provider.ts";
import { loadAccounts, loadUsageSnapshot, saveAccounts } from "./state.ts";
import { fetchUsageDirect, mergeWindows, scrubCredEnv, windowsOf } from "./usage.ts";
import type { Account, Bars, Config, UsageWindows, Window } from "./types.ts";

export type SampleOutcome = { ok: true; usage: UsageWindows; via: "get" } | { ok: false; reason: string; retryAt?: number };

type PreparedSample = { ok: true; token: string; expiresAt: number } | { ok: false; reason: string };

const SAMPLE_INTERVAL_MAX_MS = 15 * 60 * 1000;

export function sampleIntervalMs(account: Account, cfg: Config, now: number, live: boolean): number {
  const floor = cfg.policy.usagePollTtlMs;
  const bars = thresholdBars(cfg);
  const aggregates = account.windows.filter((w) => w.name == null);
  if (aggregates.length === 0) return floor;
  const blocked = (w: Window) => liveUsed(w, now) >= barFor(account, w, bars, now);
  if (!live || aggregates.some(blocked)) return Math.max(floor, SAMPLE_INTERVAL_MAX_MS);
  const open = [...aggregates, ...gatedWindows(account, cfg.policy.switchModels).filter((w) => !blocked(w))];
  const spare = Math.min(...open.map((w) => 1 - liveUsed(w, now) / barFor(account, w, bars, now)));
  return Math.max(floor, SAMPLE_INTERVAL_MAX_MS * spare);
}

const sampledAt = (a: Account) => Math.max(a.lastUsageAt ?? 0, a.lastProbeAt ?? 0);

export function sampleDue(account: Account, cfg: Config, now: number, live: boolean): boolean {
  const since = live && gatedWindows(account, cfg.policy.switchModels).length > 0 ? (account.lastProbeAt ?? 0) : sampledAt(account);
  return now - since > sampleIntervalMs(account, cfg, now, live);
}

export async function claimSample(id: string, now: number, due: (stored: Account) => boolean): Promise<boolean> {
  return withLock(claudePool.lockFile, () => {
    const idx = loadAccounts(claudePool);
    const stored = idx.accounts.find((a) => a.id === id);
    if (!stored || usageBlockedUntil(stored, now) != null || !due(stored)) return false;
    stored.lastProbeAt = now;
    saveAccounts(claudePool, idx);
    return true;
  });
}

export function teeObservation(account: Account): Observation | null {
  const stored = account.lastUsageAt != null ? { windows: account.windows, at: account.lastUsageAt } : null;
  const snap = loadUsageSnapshot(account.id);
  if (!snap) return stored;
  const at = snap.state.sampledAt ?? snap.state.ts;
  if (stored != null && at <= stored.at) return stored;
  const aggregate = windowsOf({ fiveHour: snap.state.fiveHour, sevenDay: snap.state.sevenDay, perModel: {} }, at);
  return { windows: mergeWindows(aggregate, account.windows), at };
}

export function foldTee(account: Account, thresholds: Bars): boolean {
  const observed = teeObservation(account);
  if (!observed || (account.lastUsageAt != null && observed.at <= account.lastUsageAt)) return false;
  landWindows(account, observed.windows, observed.at, thresholds);
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
  return { ok: true, token: creds.accessToken, expiresAt: creds.expiresAt };
}

export function usageBlockedUntil(account: Account, now: number): number | null {
  return account.usageRetryAt != null && account.usageRetryAt > now ? account.usageRetryAt : null;
}

function rateLimitedReason(retryAt: number, now: number): string {
  return `the usage endpoint rate limited this account, next read in ${Math.ceil((retryAt - now) / 60_000)}m`;
}

const REFRESH_KILL_MS = 60_000;

async function refreshStore(account: Account): Promise<number | null> {
  const home = mkdtempSync(join(tmpdir(), "tokenmaxxing-refresh-"));
  const env = { ...scrubCredEnv(process.env), TOKENMAXXING_PROBE: "1", [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH), CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: storeDirFor(account.id) };
  try {
    const p = Bun.spawn([resolveRealBin(CLAUDE_BIN), "-p", "/usage", "--no-session-persistence", "--safe-mode"], {
      env,
      cwd: home,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: REFRESH_KILL_MS,
      killSignal: "SIGKILL",
    });
    await p.exited;
    return p.exitCode;
  } finally {
    rmSync(home, { recursive: true, force: true });
    await withLock(claudePool.lockFile, async () => {
      if (loadAccounts(claudePool).accounts.some((a) => a.id === account.id)) return;
      await deleteItem(storeTarget(account.id));
      rmSync(storeDirFor(account.id), { recursive: true, force: true });
      rmSync(`${storeDirFor(account.id)}.lock`, { recursive: true, force: true });
    });
  }
}

export async function runSample(account: Account, prepared: { token: string; expiresAt: number }): Promise<SampleOutcome> {
  let token = prepared.token;
  if (prepared.expiresAt <= Date.now()) {
    const exit = await refreshStore(account);
    const refreshed = await prepareSample(account);
    if (!refreshed.ok) return refreshed;
    if (refreshed.expiresAt <= Date.now()) return { ok: false, reason: `the stored access token expired and claude did not refresh it (exit ${exit ?? "killed"})` };
    token = refreshed.token;
  }
  const read = await fetchUsageDirect(token);
  log("usage.read", { account: account.id.slice(0, 8), ok: read.ok });
  if (read.ok) return { ok: true, usage: read.usage, via: "get" };
  if (read.retryAt == null) return { ok: false, reason: "usage read failed (see log)" };
  return { ok: false, reason: rateLimitedReason(read.retryAt, Date.now()), retryAt: read.retryAt };
}

export async function readyToSample(account: Account, now: number): Promise<PreparedSample> {
  const blockedUntil = usageBlockedUntil(account, now);
  if (blockedUntil != null) return { ok: false, reason: rateLimitedReason(blockedUntil, now) };
  return prepareSample(account);
}

export async function sampleAccountUsage(account: Account): Promise<SampleOutcome> {
  const ready = await readyToSample(account, Date.now());
  return ready.ok ? runSample(account, ready) : ready;
}

const SAMPLE_BATCH = 3;
const STORE_FAILS_REAUTH = 5;

export async function sampleOldest(cfg: Config): Promise<void> {
  const reserved = await withLock(claudePool.lockFile, async () => {
    const now = Date.now();
    const idx = loadAccounts(claudePool);
    let dirty = false;
    for (const a of idx.accounts) dirty = foldTee(a, thresholdBars(cfg)) || dirty;
    const seats = seatCounts(paths.presenceDir);
    const stale = idx.accounts
      .filter((a) => a.needsReauth !== true && sampleDue(a, cfg, now, seats.has(a.id)))
      .sort((a, b) => Number(seats.has(b.id)) - Number(seats.has(a.id)) || sampledAt(a) - sampledAt(b))
      .slice(0, SAMPLE_BATCH);
    if (stale.length === 0) {
      if (dirty) saveAccounts(claudePool, idx);
      return [];
    }
    const batch: { account: Account; prepared: { token: string; expiresAt: number } }[] = [];
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
      if (usageBlockedUntil(target, now) == null) batch.push({ account: target, prepared });
    }
    saveAccounts(claudePool, idx);
    return batch;
  });
  await Promise.all(
    reserved.map(async ({ account, prepared }) => {
      const startedAt = Date.now();
      const outcome = await runSample(account, prepared);
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
          landWindows(stored, mergeWindows(windowsOf(outcome.usage, startedAt), stored.windows), startedAt, thresholdBars(cfg));
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
