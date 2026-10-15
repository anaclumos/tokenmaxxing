import { lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { ensurePathAhead } from "./claude.ts";
import { MUSE_BIN } from "./claudebin.ts";
import { http, safeErrorDetail } from "./http.ts";
import { isBinDirAhead, installMuseSupervisor, museSupervisorLink } from "./install.ts";
import { withLock } from "./lock.ts";
import { errorMessage, log } from "./log.ts";
import { env, museAuthJsonFor, musePaths, musePool, museSeatFromEnv, museStoreDirFor } from "./paths.ts";
import { isExhausted, landWindows, pickBest, pickEarliestReset, thresholdBars, type PickCtx } from "./picker.ts";
import { seatCounts } from "./presence.ts";
import { StoreUnusableError, type Observation, type Provider, type SampleReport } from "./provider.ts";
import { loadAccounts, loadConfig, readJsonFile, saveAccounts, type Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { EpochSecondsSchema, ErrnoSchema, JsonTextSchema, type Account, type Config, type Window } from "./types.ts";
import { c } from "../cli/render.ts";

const MuseProviderSchema = z.looseObject({
  access_token: z.string().optional(),
  user_email: z.string().nullish(),
});

const MuseAuthSchema = z.looseObject({
  providers: z.record(z.string(), z.unknown()),
});
type MuseAuth = z.infer<typeof MuseAuthSchema>;

function readFile(path: string): MuseAuth | null {
  try {
    return readJsonFile(path, MuseAuthSchema);
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return null;
    throw e;
  }
}

function readAuth(path: string): AuthEntry[] {
  const file = readFile(path);
  if (file == null) return [];
  const out: AuthEntry[] = [];
  for (const [key, value] of Object.entries(file.providers)) {
    const parsed = MuseProviderSchema.safeParse(value);
    if (!parsed.success) continue;
    const email = parsed.data.user_email?.trim().toLowerCase() ?? "";
    const id = email === "" ? "" : new Bun.CryptoHasher("sha256").update(email).digest("hex");
    const harvest: Harvest | null =
      id === ""
        ? null
        : {
            id,
            email,
            tier: null,
            sample: null,
            park: async () => {
              writeFileAtomic(museAuthJsonFor(id), JSON.stringify({ ...file, providers: { [key]: value } }, null, 2), 0o600);
            },
          };
    out.push({ id, usable: (parsed.data.access_token ?? "") !== "", harvest });
  }
  return out;
}

export function museStoreUsable(accountId: string): boolean {
  try {
    return readAuth(museAuthJsonFor(accountId)).some((e) => e.id === accountId && e.usable);
  } catch {
    return false;
  }
}

export function museStoreIdentity(accountId: string): string[] {
  return readAuth(museAuthJsonFor(accountId)).map((e) => e.id);
}

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return [];
    throw e;
  }
}

// A mirror link is one this code made: a symlink to the real config home's entry of the same name.
function isMirrorLink(from: string, to: string, name: string): boolean {
  if (lstatSync(join(to, name), { throwIfNoEntry: false })?.isSymbolicLink() !== true) return false;
  return readlinkSync(join(to, name)) === join(from, name);
}

// An entry a seated tool created (a file, a directory, or a link of its own) lives only in the store. It moves to
// the real config home, when that has no entry of the name, so it outlives the store and every seat sees it.
function adoptEntries(from: string, to: string, keep: (name: string) => boolean): void {
  for (const name of namesIn(to)) {
    const own = join(to, name);
    if (!keep(name) || isMirrorLink(from, to, name) || lstatSync(join(from, name), { throwIfNoEntry: false }) != null) continue;
    mkdirSync(from, { recursive: true });
    if (lstatSync(own).isSymbolicLink()) {
      symlinkSync(resolve(to, readlinkSync(own)), join(from, name));
      rmSync(own);
      continue;
    }
    try {
      renameSync(own, join(from, name));
    } catch (e) {
      if (ErrnoSchema.safeParse(e).data?.code !== "EXDEV") throw e;
      log("muse.adopt_cross_device", { entry: own });
    }
  }
}

function linkEntries(from: string, to: string, keep: (name: string) => boolean): void {
  adoptEntries(from, to, keep);
  for (const name of namesIn(from)) {
    if (!keep(name)) continue;
    try {
      symlinkSync(join(from, name), join(to, name));
    } catch (e) {
      if (ErrnoSchema.safeParse(e).data?.code !== "EEXIST") throw e;
    }
  }
}

function sharedTop(name: string): boolean {
  return name !== "muse" && !`${musePaths.storesDir}${sep}`.startsWith(join(musePaths.configHome, name) + sep);
}

function sharedMuse(name: string): boolean {
  return !name.startsWith("auth.json") && !name.endsWith(".lock");
}

// The store doubles as the seated session's XDG_CONFIG_HOME, which every tool the session runs inherits, so it
// mirrors the real config home: a link to each entry but `muse`, and in `muse/` a link to each entry but the login.
export function ensureMuseStoreHome(accountId: string): string {
  const store = museStoreDirFor(accountId);
  const config = join(store, "muse");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  linkEntries(musePaths.configHome, store, sharedTop);
  linkEntries(join(musePaths.configHome, "muse"), config, sharedMuse);
  return store;
}

// Deletes the login and the mirror links. An entry only the store holds moves to the real config home first; one
// the real config home also holds (a settings.json Muse Code rewrote in place of its link) stays, with the store.
function removeMuseStore(accountId: string): void {
  const store = museStoreDirFor(accountId);
  const config = join(store, "muse");
  for (const name of namesIn(config)) if (name.startsWith("auth.json")) rmSync(join(config, name), { force: true });
  adoptEntries(musePaths.configHome, store, sharedTop);
  adoptEntries(join(musePaths.configHome, "muse"), config, sharedMuse);
  for (const [from, dir] of [[join(musePaths.configHome, "muse"), config], [musePaths.configHome, store]] as const) {
    for (const name of namesIn(dir)) if (isMirrorLink(from, dir, name)) rmSync(join(dir, name), { force: true });
  }
  const kept = [...namesIn(config).map((n) => join(config, n)), ...namesIn(store).filter((n) => n !== "muse").map((n) => join(store, n))];
  if (kept.length > 0) {
    console.log(c.yellow(`kept ${store}: it holds ${kept.join(", ")}, which the real config home also has - merge or delete by hand`));
    return;
  }
  rmSync(store, { recursive: true, force: true });
}

const SubscriptionWindowSchema = z.looseObject({ used_percent: z.number(), resets_at: EpochSecondsSchema });

const MintSchema = z.looseObject({
  subs_usage: z
    .looseObject({
      window: SubscriptionWindowSchema.extend({ window_duration_mins: z.number() }),
      weekly: SubscriptionWindowSchema,
    })
    .nullish(),
});

const WEEK_S = 7 * 86400;

function usageUrl(): string {
  return env("TOKENMAXXING_MUSE_USAGE_URL", "https://api.meta.ai/muse-code/key");
}

function storedAccessToken(id: string): string | null {
  const file = readFile(museAuthJsonFor(id));
  if (file == null) return null;
  for (const value of Object.values(file.providers)) {
    const token = MuseProviderSchema.safeParse(value).data?.access_token ?? "";
    if (token !== "") return token;
  }
  return null;
}

// windows null: the mint carried no subs_usage, which it leaves out while no 5-hour window is open.
type MuseRead = { ok: true; windows: Window[] | null; at: number } | { ok: false; reason: string; rejected: boolean };

// With no window open, a stored window that has not reset (the weekly one at its limit, say) still binds.
function landedWindows(read: { windows: Window[] | null }, stored: Window[], now: number): Window[] {
  return read.windows ?? stored.filter((w) => w.resetsAt != null && w.resetsAt > now);
}

async function readMuseUsage(accountId: string, now: number): Promise<MuseRead> {
  let token: string | null;
  try {
    token = storedAccessToken(accountId);
  } catch (e) {
    return { ok: false, rejected: false, reason: `this account's store is unreadable (${errorMessage(e)}) - run \`tokenmaxxing auth --muse\`` };
  }
  if (token == null) return { ok: false, rejected: false, reason: "no access_token in this account's store - run `tokenmaxxing auth --muse`" };
  let res: Response;
  let text: string;
  try {
    res = await http.post(usageUrl(), { headers: { Authorization: `Bearer ${token}` }, json: {} });
    text = await res.text();
  } catch (e) {
    return { ok: false, rejected: false, reason: `Muse Code usage read failed: endpoint unreachable: ${errorMessage(e)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, rejected: true, reason: `Muse Code rejected the stored login (HTTP ${res.status}) - run \`tokenmaxxing auth --muse\`` };
  }
  if (!res.ok) return { ok: false, rejected: false, reason: `Muse Code usage read failed: HTTP ${res.status}: ${safeErrorDetail({ text })}` };
  const parsed = MintSchema.safeParse(JsonTextSchema.safeParse(text).data);
  if (!parsed.success) return { ok: false, rejected: false, reason: "Muse Code usage read failed: endpoint returned an unexpected body shape (withheld)" };
  if (parsed.data.subs_usage == null) return { ok: true, windows: null, at: now };
  const { window, weekly } = parsed.data.subs_usage;
  return {
    ok: true,
    at: now,
    windows: [
      { name: null, usedPercentage: window.used_percent, resetsAt: window.resets_at, windowSeconds: window.window_duration_mins * 60, sampledAt: now },
      { name: null, usedPercentage: weekly.used_percent, resetsAt: weekly.resets_at, windowSeconds: WEEK_S, sampledAt: now },
    ],
  };
}

async function samplePool(accounts: Account[], now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(
    accounts.map(async (account) => {
      const read = await readMuseUsage(account.id, now);
      if (read.ok) {
        account.windows = landedWindows(read, account.windows, read.at);
        account.lastUsageAt = read.at;
        reports.set(account.id, { ok: true, source: "probe" });
        return;
      }
      if (read.rejected) account.needsReauth = true;
      reports.set(account.id, { ok: false, reason: read.reason });
    }),
  );
  return reports;
}

export async function observeMuse(account: Account, cfg: Config, now: number, opts: { probe: boolean }): Promise<Observation | null> {
  if (opts.probe && (account.lastUsageAt == null || now - account.lastUsageAt > cfg.policy.usagePollTtlMs)) {
    const read = await readMuseUsage(account.id, Date.now());
    if (!read.ok) log("muse.usage_failed", { account: account.id.slice(0, 8), reason: read.reason.slice(0, 200) });
    await withLock(musePool.lockFile, () => {
      const idx = loadAccounts(musePool);
      const a = idx.accounts.find((x) => x.id === account.id);
      if (!a) return;
      if (read.ok) {
        if (a.lastUsageAt == null || read.at > a.lastUsageAt) landWindows(a, landedWindows(read, a.windows, read.at), read.at, thresholdBars(cfg));
      } else if (read.rejected) {
        a.needsReauth = true;
      }
      saveAccounts(musePool, idx);
    });
  }
  const current = loadAccounts(musePool).accounts.find((a) => a.id === account.id) ?? account;
  return current.lastUsageAt != null ? { windows: current.windows, at: current.lastUsageAt } : null;
}

function presence(): Map<string, number> {
  return seatCounts(musePaths.presenceDir);
}

function seatable(a: Account): boolean {
  return a.needsReauth !== true && museStoreUsable(a.id);
}

// Reads the usage of every seatable account whose sample is stale. It takes the pool lock itself, so it runs
// before the lock a placement holds.
export async function probeMuseSeats(now: number): Promise<void> {
  const cfg = loadConfig();
  await Promise.all(loadAccounts(musePool).accounts.filter(seatable).map((a) => observeMuse(a, cfg, now, { probe: true })));
}

export function museSeatOpen(a: Account, now: number): boolean {
  return seatable(a) && !isExhausted(a, { now, thresholds: thresholdBars(loadConfig()), currentId: null, families: null, seats: null });
}

// Ranks the stored accounts the way a move does, spreading sessions across accounts with the same headroom; with
// none under its bars, the one that frees up first. Call it under the pool lock, after probeMuseSeats.
export function rankMuseSeat(now: number): Account | null {
  const ctx: PickCtx = { now, thresholds: thresholdBars(loadConfig()), currentId: null, families: null, seats: presence() };
  const open = loadAccounts(musePool).accounts.filter(seatable);
  return pickBest(open, ctx) ?? pickEarliestReset(open, ctx)?.account ?? null;
}

async function prepareMove(target: Account): Promise<void> {
  if (!museStoreUsable(target.id)) {
    throw new StoreUnusableError(`${target.label} has no usable login in its store - run \`tokenmaxxing auth --muse ${target.label}\``);
  }
  log("move.prepared", { account: target.id.slice(0, 8), label: target.label, muse: true });
}

function install(): void {
  installMuseSupervisor();
  console.log(`${c.green("✓")} muse supervisor installed at ${museSupervisorLink()}`);
  if (!isBinDirAhead(MUSE_BIN)) ensurePathAhead();
}

const base = statusOnlyProvider({
  name: "muse",
  flag: " --muse",
  pool: musePool,
  binName: MUSE_BIN.name,
  binKey: MUSE_BIN.key,
  storeDirFor: museStoreDirFor,
  authJsonFor: museAuthJsonFor,
  homeEnv: "XDG_CONFIG_HOME",
  loginArgs: ["login"],
  onboardAuthRel: "muse/auth.json",
  liveAuthPath: () => musePaths.authJson,
  readAuth,
  liveId: () => museSeatFromEnv(loadAccounts(musePool).accounts.map((a) => a.id)),
  presence,
  versionOk: MUSE_BIN.versionOk,
  importIntro: "Opening an isolated Muse Code login for your first pooled account - the login you already have stays as it is.",
  foundLive: (count) => `found ${count} Muse Code login(s) in ${musePaths.authJson} - pooling the first; use \`tokenmaxxing add --muse\` for the rest.`,
  install,
  loginStep: () => `Approve the code in the browser that ${c.bold("muse login")} opens.`,
  samplePool,
});

export const muse: Provider = {
  ...base,
  seats: "shared",
  statusOnly: false,
  observeLive: (account, cfg, now, opts) => observeMuse(account, cfg, now, { probe: opts.probe }),
  swap: prepareMove,
  removeCredentials: async (a) => removeMuseStore(a.id),
  classifySwapError: (e) => (e instanceof StoreUnusableError ? "skip" : "fatal"),
};
