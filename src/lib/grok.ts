import { mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { ensurePathAhead } from "./claude.ts";
import { GROK_BIN } from "./claudebin.ts";
import { fetchGrokUsage, GrokUsageReadError } from "./grokusage.ts";
import { isBinDirAhead, installGrokSupervisor, grokSupervisorLink } from "./install.ts";
import { withLock } from "./lock.ts";
import { errorMessage, log } from "./log.ts";
import { grokAuthJsonFor, grokPaths, grokPool, grokSeatFromEnv, grokStoreDirFor } from "./paths.ts";
import { isExhausted, landWindows, pickBest, pickEarliestReset, thresholdBars, type PickCtx } from "./picker.ts";
import { seatCounts } from "./presence.ts";
import { StoreUnusableError, type Observation, type Provider, type SampleReport } from "./provider.ts";
import { loadAccounts, loadConfig, readJsonFile, saveAccounts, type Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { ErrnoSchema, InstantSchema, type Account, type Config, type Window } from "./types.ts";
import { c } from "../cli/render.ts";

const GrokAuthEntrySchema = z.looseObject({
  user_id: z.string().optional(),
  principal_id: z.string().optional(),
  email: z.string().nullish(),
  first_name: z.string().nullish(),
  key: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_at: z.string().nullish(),
});
type GrokAuthEntry = z.infer<typeof GrokAuthEntrySchema>;

type GrokCred = { id: string; token: string; expiresAt: number | null };

function accountIdOf(entry: GrokAuthEntry, key: string): string {
  return entry.user_id ?? entry.principal_id ?? key;
}

function liveGrokAuthPath(): string {
  return join(grokPaths.home, "auth.json");
}

function adoptGrokAuthFromLive(accountId: string): boolean {
  for (const [key, entry] of readMap(liveGrokAuthPath())) {
    if (accountIdOf(entry, key) !== accountId) continue;
    writeFileAtomic(grokAuthJsonFor(accountId), JSON.stringify({ [key]: entry }, null, 2), 0o600);
    return true;
  }
  return false;
}

function detachGrokLoginFromLiveHome(accountId: string): void {
  const livePath = liveGrokAuthPath();
  const kept: Record<string, GrokAuthEntry> = {};
  for (const [key, entry] of readMap(livePath)) {
    if (accountIdOf(entry, key) === accountId) continue;
    kept[key] = entry;
  }
  if (Object.keys(kept).length === 0) {
    rmSync(livePath, { force: true });
    return;
  }
  writeFileAtomic(livePath, JSON.stringify(kept, null, 2), 0o600);
}

export async function parkGrokEntry(id: string, key: string, entry: GrokAuthEntry): Promise<void> {
  await harvestOf(id, key, entry).park();
}

function harvestOf(id: string, key: string, entry: GrokAuthEntry): Harvest {
  return {
    id,
    email: entry.email ?? null,
    tier: null,
    sample: null,
    park: async () => {
      writeFileAtomic(grokAuthJsonFor(id), JSON.stringify({ [key]: entry }, null, 2), 0o600);
      detachGrokLoginFromLiveHome(id);
    },
  };
}

function readMap(path: string): [string, GrokAuthEntry][] {
  let map: Record<string, unknown>;
  try {
    map = readJsonFile(path, z.record(z.string(), z.unknown()));
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return [];
    throw e;
  }
  const out: [string, GrokAuthEntry][] = [];
  for (const [key, value] of Object.entries(map)) {
    const parsed = GrokAuthEntrySchema.safeParse(value);
    if (!parsed.success) continue;
    out.push([key, parsed.data]);
  }
  return out;
}

function readAuth(path: string): AuthEntry[] {
  const out: AuthEntry[] = [];
  for (const [key, entry] of readMap(path)) {
    const id = entry.user_id ?? entry.principal_id ?? key;
    out.push({ id, usable: (entry.refresh_token ?? "") !== "", harvest: id === "" ? null : harvestOf(id, key, entry) });
  }
  return out;
}

function credsIn(path: string): GrokCred[] {
  const out: GrokCred[] = [];
  for (const [key, entry] of readMap(path)) {
    const id = entry.user_id ?? entry.principal_id ?? key;
    const token = entry.key ?? "";
    if (id === "" || token === "") continue;
    out.push({ id, token, expiresAt: InstantSchema.safeParse(entry.expires_at).data ?? null });
  }
  return out;
}

function liveCred(accountId: string): GrokCred | null {
  return credsIn(join(grokPaths.home, "auth.json")).find((c) => c.id === accountId) ?? null;
}

function bearerFor(accountId: string, now: number): { token: string; from: "store" | "live" } | null {
  const store = credsIn(grokAuthJsonFor(accountId)).find((c) => c.id === accountId) ?? null;
  const live = liveCred(accountId);
  if (store != null && (store.expiresAt == null || store.expiresAt > now + 60_000)) return { token: store.token, from: "store" };
  if (live != null) return { token: live.token, from: "live" };
  if (store != null) return { token: store.token, from: "store" };
  return null;
}

type GrokRead = { ok: true; windows: Window[] } | { ok: false; reason: string; rejected: boolean };

async function readGrokUsage(account: Account, now: number): Promise<GrokRead> {
  let first: { token: string; from: "store" | "live" } | null;
  try {
    first = bearerFor(account.id, now);
  } catch (e) {
    return { ok: false, rejected: false, reason: `this account's store is unreadable (${errorMessage(e)}) - run \`tokenmaxxing auth --grok\`` };
  }
  if (first == null) return { ok: false, rejected: false, reason: "no usable credential in this account's store - run `tokenmaxxing auth --grok`" };
  try {
    return { ok: true, windows: await fetchGrokUsage({ token: first.token, at: now }) };
  } catch (e) {
    const live = e instanceof GrokUsageReadError && e.status === 401 && first.from === "store" ? liveCred(account.id) : null;
    if (live != null && live.token !== first.token) {
      try {
        const windows = await fetchGrokUsage({ token: live.token, at: now });
        adoptGrokAuthFromLive(account.id);
        return { ok: true, windows };
      } catch (retry) {
        const rejected = retry instanceof GrokUsageReadError && retry.status === 401;
        return { ok: false, rejected, reason: errorMessage(retry) };
      }
    }
    const rejected = e instanceof GrokUsageReadError && e.status === 401;
    return { ok: false, rejected, reason: errorMessage(e) };
  }
}

async function samplePool(accounts: Account[], now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(
    accounts.map(async (account) => {
      const read = await readGrokUsage(account, now);
      if (read.ok) {
        account.windows = read.windows;
        account.lastUsageAt = now;
        delete account.needsReauth;
        reports.set(account.id, { ok: true, source: "probe" });
        return;
      }
      if (read.rejected) account.needsReauth = true;
      reports.set(account.id, { ok: false, reason: read.reason });
    }),
  );
  return reports;
}

export async function observeGrok(account: Account, cfg: Config, now: number, opts: { probe: boolean }): Promise<Observation | null> {
  if (opts.probe && (account.lastUsageAt == null || now - account.lastUsageAt > cfg.policy.usagePollTtlMs)) {
    const at = Date.now();
    const read = await readGrokUsage(account, at);
    if (!read.ok) log("grok.usage_failed", { account: account.id.slice(0, 8), reason: read.reason.slice(0, 200) });
    await withLock(grokPool.lockFile, () => {
      const idx = loadAccounts(grokPool);
      const a = idx.accounts.find((x) => x.id === account.id);
      if (!a) return;
      if (read.ok) {
        if (a.lastUsageAt == null || at > a.lastUsageAt) landWindows(a, read.windows, at, thresholdBars(cfg));
        delete a.needsReauth;
      } else if (read.rejected) {
        a.needsReauth = true;
      }
      saveAccounts(grokPool, idx);
    });
  }
  const current = loadAccounts(grokPool).accounts.find((a) => a.id === account.id) ?? account;
  return current.lastUsageAt != null ? { windows: current.windows, at: current.lastUsageAt } : null;
}

export function grokStoreUsable(accountId: string): boolean {
  try {
    return readAuth(grokAuthJsonFor(accountId)).some((e) => e.id === accountId && e.usable);
  } catch {
    return false;
  }
}

export function grokStoreIdentity(accountId: string): string[] {
  return readAuth(grokAuthJsonFor(accountId)).map((e) => e.id);
}

export function ensureGrokStoreHome(accountId: string): string {
  const store = grokStoreDirFor(accountId);
  mkdirSync(store, { recursive: true });
  mkdirSync(grokPaths.home, { recursive: true });
  mkdirSync(join(grokPaths.home, "sessions"), { recursive: true });
  for (const name of readdirSync(grokPaths.home)) {
    if (name.startsWith("auth.json")) continue;
    try {
      symlinkSync(join(grokPaths.home, name), join(store, name));
    } catch (e) {
      if (ErrnoSchema.safeParse(e).data?.code !== "EEXIST") throw e;
    }
  }
  return store;
}

function presence(): Map<string, number> {
  return seatCounts(grokPaths.presenceDir);
}

function seatable(a: Account): boolean {
  return a.needsReauth !== true && grokStoreUsable(a.id);
}

export async function probeGrokSeats(now: number): Promise<void> {
  const cfg = loadConfig();
  await Promise.all(loadAccounts(grokPool).accounts.filter(seatable).map((a) => observeGrok(a, cfg, now, { probe: true })));
}

export function grokSeatOpen(a: Account, now: number): boolean {
  return seatable(a) && !isExhausted(a, { now, thresholds: thresholdBars(loadConfig()), currentId: null, families: null, seats: null });
}

export function rankGrokSeat(now: number): Account | null {
  const ctx: PickCtx = { now, thresholds: thresholdBars(loadConfig()), currentId: null, families: null, seats: presence() };
  const open = loadAccounts(grokPool).accounts.filter(seatable);
  return pickBest(open, ctx) ?? pickEarliestReset(open, ctx)?.account ?? null;
}

async function prepareMove(target: Account): Promise<void> {
  if (!grokStoreUsable(target.id)) {
    throw new StoreUnusableError(`${target.label} has no usable login in its store - run \`tokenmaxxing auth --grok ${target.label}\``);
  }
  log("move.prepared", { account: target.id.slice(0, 8), label: target.label, grok: true });
}

function install(): void {
  installGrokSupervisor();
  console.log(`${c.green("✓")} grok supervisor installed at ${grokSupervisorLink()}`);
  if (!isBinDirAhead(GROK_BIN)) ensurePathAhead();
}

const base = statusOnlyProvider({
  name: "grok",
  flag: " --grok",
  pool: grokPool,
  bin: GROK_BIN,
  storeDirFor: grokStoreDirFor,
  authJsonFor: grokAuthJsonFor,
  homeEnv: "GROK_HOME",
  loginArgs: () => ["login"],
  onboardAuthRel: "auth.json",
  readAuth,
  liveId: () => grokSeatFromEnv(loadAccounts(grokPool).accounts.map((a) => a.id)),
  presence,
  importIntro:
    "Pooling your grok login from the ambient grok home - any other logins there are left as they are; the pooled account is removed from that home so grok refresh rotation cannot revoke the store copy.",
  live: {
    read: () => readAuth(join(grokPaths.home, "auth.json")),
    found: (count) => `found ${count} grok login(s) in ${grokPaths.home} - pooling the first; use \`tokenmaxxing add --grok\` for the rest.`,
  },
  install,
  loginStep: () => `Sign in in the browser session that opens (or run ${c.bold("grok login --device-auth")} on headless hosts first).`,
  samplePool,
});

export const grok: Provider = {
  ...base,
  seats: "shared",
  statusOnly: false,
  observeLive: (account, cfg, now, opts) => observeGrok(account, cfg, now, { probe: opts.probe }),
  swap: prepareMove,
  classifySwapError: (e) => (e instanceof StoreUnusableError ? "skip" : "fatal"),
};
