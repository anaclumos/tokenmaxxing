import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { countBy } from "es-toolkit";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { CODEX_BIN, MAX_WRAP_DEPTH, WRAP_DEPTH_ENV, resolveRealBin, verifyRealBin } from "./claudebin.ts";
import { codexIdentityOf, codexStoreUsable, deleteCodexStoreAuth, ensureCodexStoreHome, isCodexAccessExpiring, readCodexAuthAt, readCodexStoreAuth, writeCodexStoreAuth } from "./codexauth.ts";
import { CodexInvalidGrantError, CodexRefreshFailedError, refreshCodexAuth } from "./codexoauth.ts";
import { onboardHome } from "./onboard.ts";
import { deletePiStore } from "./piauth.ts";
import { PI_PRESENCE_PREFIX, livingPresences, seatCounts, writePresence } from "./presence.ts";
import { CodexUsageReadError, codexLimitLabel, consumeCodexReset, fetchCodexUsage } from "./codexusage.ts";
import { codexSupervisorLink, ensurePathInRc, installCodexSupervisor, managedShellRcSkipLines, shellRcPath } from "./install.ts";
import { withLock } from "./lock.ts";
import { errorMessage, log } from "./log.ts";
import { codexPaths, codexPool, codexSeatFromEnv, optionalEnv } from "./paths.ts";
import { isExhausted, landGrant, onCredits, pickBest, pickEarliestReset, thresholdBars, type PickCtx } from "./picker.ts";
import { StoreUnusableError, type Observation, type Provider, type SampleReport, type SeatBorrow } from "./provider.ts";
import { loadAccounts, loadConfig, pinBinOverride, saveAccounts, type Harvest } from "./state.ts";
import { restoreTermios, saveTermios } from "./tty.ts";
import type { Account, CodexAuthJson, CodexUsage, Config } from "./types.ts";
import { c } from "../cli/render.ts";

export const CODEX_SUPERVISOR_ID_ENV = "TOKENMAXXING_CODEX_SUPERVISOR_ID";
export const CODEX_CRED_ENV = ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY"] as const;

function liveId(): string | null {
  return codexSeatFromEnv(loadAccounts(codexPool).accounts.map((a) => a.id));
}

function presence(): Map<string, number> {
  return seatCounts(codexPaths.presenceDir);
}

function applyUsage(account: Account, usage: CodexUsage, at: number): void {
  account.windows = usage.windows;
  account.lastUsageAt = at;
  account.hasCredits = usage.hasCredits ?? undefined;
  landGrant(account, usage.bankedReset, at);
  if (usage.email != null) account.email = usage.email;
  if (usage.planType != null) account.tier = usage.planType;
}

type CodexReadFailure = { ok: false; reason: string; deadGrant: boolean; deadAccessToken?: string; expiring?: boolean; rejected?: boolean; rejectedToken?: string };
type CodexReadOutcome = { ok: true; usage: CodexUsage; at: number } | CodexReadFailure;

const REJECTED_REFRESH_BACKOFF_MS = 60 * 60 * 1000;

function afterRejection(rejected: CodexReadFailure, refreshFailure: CodexReadFailure): CodexReadFailure {
  return { ...refreshFailure, rejected: true, reason: `${rejected.reason}; refresh skipped: ${refreshFailure.reason}` };
}

function storeHolds(accountId: string, accessToken: string | undefined): boolean {
  if (accessToken === undefined) return true;
  try {
    return readCodexStoreAuth(accountId)?.tokens.access_token === accessToken;
  } catch {
    return false;
  }
}

async function freshCodexAuth(account: Account, now: number, refresh: boolean, holder?: string, rejectedToken?: string): Promise<{ ok: true; auth: CodexAuthJson } | CodexReadFailure> {
  let auth: CodexAuthJson | null;
  try {
    auth = readCodexStoreAuth(account.id);
  } catch (e) {
    return { ok: false, reason: `store credential unreadable (${errorMessage(e).slice(0, 80)})`, deadGrant: false };
  }
  if (!auth) return { ok: false, reason: "no credential in this account's store - run `tokenmaxxing auth --codex`", deadGrant: false };
  const expiring = isCodexAccessExpiring({ auth, now });
  if (auth.tokens.access_token !== rejectedToken && !expiring) return { ok: true, auth };
  if (!expiring && auth.last_refresh != null && now - Date.parse(auth.last_refresh) < REJECTED_REFRESH_BACKOFF_MS) {
    return { ok: false, reason: "the store was refreshed within the last hour", deadGrant: false };
  }
  if (!refresh) return { ok: false, reason: "stored access token is expiring and this read never refreshes a store", deadGrant: false, expiring: true };
  if (livingPresences(codexPaths.presenceDir).some((p) => p.accountId === account.id && p.id !== holder)) {
    return { ok: false, reason: "running in a live codex session (store refresh unsafe)", deadGrant: false };
  }
  try {
    auth = await refreshCodexAuth({ auth, now });
  } catch (e) {
    if (e instanceof CodexInvalidGrantError) return { ok: false, reason: e.message, deadGrant: true, deadAccessToken: auth.tokens.access_token };
    if (e instanceof CodexRefreshFailedError) return { ok: false, reason: e.message, deadGrant: false };
    throw e;
  }
  writeCodexStoreAuth(account.id, auth);
  return { ok: true, auth };
}

async function readCodexUsageOnce(account: Account, now: number, refresh: boolean, holder?: string, rejectedToken?: string): Promise<CodexReadOutcome> {
  const fresh = await freshCodexAuth(account, now, refresh, holder, rejectedToken);
  if (!fresh.ok) return fresh;
  try {
    const at = Date.now();
    return { ok: true, usage: await fetchCodexUsage({ auth: fresh.auth, at }), at };
  } catch (e) {
    if (e instanceof CodexUsageReadError) return { ok: false, reason: e.message, deadGrant: false, rejected: e.status === 401, rejectedToken: e.status === 401 ? fresh.auth.tokens.access_token : undefined };
    throw e;
  }
}

async function readCodexUsage(account: Account, now: number, refresh: boolean, holder?: string): Promise<CodexReadOutcome> {
  const outcome = await readCodexUsageOnce(account, now, refresh, holder);
  if (outcome.ok || outcome.rejectedToken === undefined) return outcome;
  const { rejectedToken } = outcome;
  const fresh = await withLock(codexPool.lockFile, () => freshCodexAuth(account, now, true, holder, rejectedToken));
  if (!fresh.ok) return afterRejection(outcome, fresh);
  const retried = await readCodexUsageOnce(account, now, false);
  return retried.ok ? retried : { ...retried, rejectedToken: undefined };
}

export async function observeCodex(account: Account, cfg: Config, now: number, opts: { probe: boolean; refresh: boolean; holder?: string; rejected?: Set<string> }): Promise<Observation | null> {
  if (opts.probe && (account.lastUsageAt == null || now - account.lastUsageAt > cfg.policy.usagePollTtlMs)) {
    const outcome = await readCodexUsage(account, now, opts.refresh, opts.holder);
    if (!outcome.ok && outcome.rejected === true) opts.rejected?.add(account.id);
    await withLock(codexPool.lockFile, () => {
      const idx = loadAccounts(codexPool);
      const a = idx.accounts.find((x) => x.id === account.id);
      if (!a) return;
      if (outcome.ok) {
        if (a.lastUsageAt == null || outcome.at > a.lastUsageAt) {
          applyUsage(a, outcome.usage, outcome.at);
        }
      } else if (outcome.deadGrant && storeHolds(a.id, outcome.deadAccessToken)) {
        a.needsReauth = true;
      }
      saveAccounts(codexPool, idx);
    });
  }
  const current = loadAccounts(codexPool).accounts.find((a) => a.id === account.id) ?? account;
  return current.lastUsageAt != null ? { windows: current.windows, at: current.lastUsageAt } : null;
}

async function samplePool(accounts: Account[], now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  const record = (account: Account, outcome: CodexReadOutcome): void => {
    if (outcome.ok) {
      applyUsage(account, outcome.usage, outcome.at);
      reports.set(account.id, { ok: true, source: "probe" });
    } else {
      reports.set(account.id, { ok: false, reason: outcome.reason });
    }
  };
  const expiring: { account: Account; rejected?: CodexReadFailure }[] = [];
  await Promise.all(
    accounts.map(async (account) => {
      const outcome = await readCodexUsageOnce(account, now, false);
      if (!outcome.ok && (outcome.expiring === true || outcome.rejectedToken !== undefined)) expiring.push({ account, rejected: outcome.rejectedToken === undefined ? undefined : outcome });
      else record(account, outcome);
    }),
  );
  if (expiring.length > 0) {
    const rotated = await withLock(codexPool.lockFile, async () => {
      const results = await Promise.all(expiring.map(async ({ account, rejected }) => ({ account, rejected, fresh: await freshCodexAuth(account, now, true, undefined, rejected?.rejectedToken) })));
      const dead = new Set(results.filter(({ fresh }) => !fresh.ok && fresh.deadGrant).map(({ account }) => account.id));
      if (dead.size > 0) {
        const idx = loadAccounts(codexPool);
        for (const a of idx.accounts) if (dead.has(a.id)) a.needsReauth = true;
        saveAccounts(codexPool, idx);
      }
      return results;
    });
    await Promise.all(
      rotated.map(async ({ account, rejected, fresh }) =>
        record(account, fresh.ok ? await readCodexUsageOnce(account, now, false) : rejected ? afterRejection(rejected, fresh) : fresh),
      ),
    );
  }
  return reports;
}

async function prepareMove(target: Account): Promise<void> {
  let auth: CodexAuthJson | null;
  try {
    auth = readCodexStoreAuth(target.id);
  } catch (e) {
    throw new StoreUnusableError(`${target.label}'s store is unreadable (${errorMessage(e)}) - re-auth with \`tokenmaxxing auth --codex ${target.label}\``);
  }
  if (!auth) throw new StoreUnusableError(`${target.label} has no credential in its store - re-auth with \`tokenmaxxing auth --codex ${target.label}\``);
  log("move.prepared", { account: target.id.slice(0, 8), label: target.label });
}

async function login(): Promise<Harvest | null> {
  const real = resolveRealBin(CODEX_BIN);
  const onboardDir = await onboardHome("codex");
  writeFileAtomic(join(onboardDir, "config.toml"), 'cli_auth_credentials_store = "file"\n');

  const savedTermios = saveTermios();
  const p = Bun.spawn([real, "login", "--device-auth"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      CODEX_HOME: onboardDir,
      TOKENMAXXING_PROBE: "1",
      [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH),
    },
  });
  await p.exited;
  restoreTermios(savedTermios);

  try {
    const auth = readCodexAuthAt({ path: join(onboardDir, "auth.json") });
    if (p.exitCode !== 0 || !auth) {
      console.error(c.red("no codex login landed in the isolated home - nothing added."));
      return null;
    }
    const identity = codexIdentityOf({ auth });
    const usage = await sampleLogin(auth);
    return {
      id: identity.id,
      email: usage?.usage.email ?? identity.email,
      tier: usage?.usage.planType ?? identity.planType,
      sample: usage ? { windows: usage.usage.windows, at: usage.at } : null,
      park: async () => writeCodexStoreAuth(identity.id, auth),
    };
  } finally {
    rmSync(onboardDir, { recursive: true, force: true });
  }
}

async function sampleLogin(auth: CodexAuthJson): Promise<{ usage: CodexUsage; at: number } | null> {
  console.log(c.dim("sampling usage..."));
  const at = Date.now();
  try {
    return { usage: await fetchCodexUsage({ auth, at }), at };
  } catch (e) {
    if (!(e instanceof CodexUsageReadError)) throw e;
    console.log(c.yellow("could not sample usage now - it will fill in on first use."));
    return null;
  }
}

async function importLive(): Promise<Harvest | null> {
  console.log(c.cyan("Opening an isolated codex login for your first pooled account - the login you already have stays as it is for sessions started outside the supervisor."));
  console.log();
  return login();
}

const CodexStoreModeSchema = z.looseObject({ cli_auth_credentials_store: z.string().optional() });

function storePinnedAwayFromFile(): boolean {
  const configToml = `${codexPaths.home}/config.toml`;
  if (!existsSync(configToml)) return false;
  const store = CodexStoreModeSchema.parse(Bun.TOML.parse(readFileSync(configToml, "utf8"))).cli_auth_credentials_store;
  return store !== undefined && store !== "file";
}

function preflight(): void {
  const real = resolveRealBin(CODEX_BIN);
  const fail = verifyRealBin({ ...CODEX_BIN, bin: real });
  if (fail !== null) throw new Error(`codex binary failed verification: ${real}: ${fail}`);
  pinBinOverride({ key: "codexBin", bin: real });
  if (storePinnedAwayFromFile()) {
    throw new Error(
      'codex config.toml pins cli_auth_credentials_store away from the plain auth.json file tokenmaxxing swaps - set cli_auth_credentials_store = "file" in ~/.codex/config.toml, run `codex login`, then re-run this.',
    );
  }
}

function install(): void {
  installCodexSupervisor();
  const rc = shellRcPath();
  if (rc && ensurePathInRc(rc) === "skipped") {
    const hint = managedShellRcSkipLines();
    console.log(c.yellow(`⚠ ${hint.headline}`));
    console.log(c.yellow(`  ${hint.detail}`));
    console.log(c.yellow(`  ${hint.exportLine}`));
  }
  console.log(`${c.green("✓")} codex supervisor installed at ${codexSupervisorLink()}`);
  console.log(`${c.green("✓")} Stop hook declared in ${codexPaths.hooksJson}`);
  console.log();
  console.log(c.bold(c.yellow("one manual step per seat: codex trusts hooks per store path.")));
  console.log(c.yellow("open a supervised codex session on each pooled account, run /hooks, and trust the tokenmaxxing Stop hook - auto-switching stays inert on an untrusted seat."));
  console.log(c.yellow("`tokenmaxxing doctor` lists seats still needing trust."));
}

// Relative to Plus. prolite (Pro 100) is 5x per OpenAI's launch; pro (Pro 200) was 20x and is about 10x for new
// subscribers; promax (Pro 500) is unpublished beyond "the most". Business, Enterprise, and Edu seats match Plus.
const CODEX_PLAN_WEIGHTS: Record<string, number> = {
  free: 0.2,
  go: 0.5,
  plus: 1,
  team: 1,
  business: 1,
  enterprise: 1,
  ent26: 1,
  edu: 1,
  edu_plus: 1,
  prolite: 5,
  self_serve_business_prolite: 5,
  edu_pro: 5,
  pro: 10,
  promax: 20,
};

export function codexPlanWeight(a: Account): number {
  return (a.tier == null ? undefined : CODEX_PLAN_WEIGHTS[a.tier.toLowerCase()]) ?? 1;
}

export function codexPickCtx(now: number, currentId: string | null): PickCtx {
  return { now, thresholds: thresholdBars(loadConfig()), currentId, families: null, seats: null, planWeight: codexPlanWeight };
}

export function pickCodexSeat(now: number, eligible: (a: Account) => boolean = (a) => codexStoreUsable(a.id)): Account | null {
  const ctx = codexPickCtx(now, null);
  const present = seatCounts(codexPaths.presenceDir);
  const open = loadAccounts(codexPool).accounts.filter((a) => a.needsReauth !== true && !present.has(a.id) && eligible(a));
  return pickBest(open.filter((a) => !isExhausted(a, ctx)), ctx) ?? pickEarliestReset(open, ctx)?.account ?? null;
}

export async function borrowCodexSeat(pid: number, seatId = `seat-${pid}`): Promise<SeatBorrow> {
  const now = Date.now();
  const cfg = loadConfig();
  const rejected = new Set<string>();
  await Promise.all(
    loadAccounts(codexPool)
      .accounts.filter((a) => a.needsReauth !== true && codexStoreUsable(a.id))
      .map((a) => observeCodex(a, cfg, now, { probe: true, refresh: false, rejected })),
  );
  const granted = await withLock(codexPool.lockFile, (): SeatBorrow => {
    const ctx = codexPickCtx(now, null);
    const idx = loadAccounts(codexPool);
    const living = livingPresences(codexPaths.presenceDir);
    const held = living.find((p) => p.id === seatId);
    const heldAccount = held ? (idx.accounts.find((x) => x.id === held.accountId) ?? null) : null;
    if (heldAccount) {
      if (rejected.has(heldAccount.id)) {
        return { denied: "the usage endpoint rejects the account this pid holds and its store could not be refreshed now - borrow again later" };
      }
      if (heldAccount.needsReauth === true) {
        return { denied: "the account this pid holds needs reauthentication - run `tokenmaxxing auth --codex` and borrow again" };
      }
      if (!codexStoreUsable(heldAccount.id)) {
        return { denied: "the account this pid holds has no usable credential in its store - refusing to hand back a credential-less seat" };
      }
      return { store: ensureCodexStoreHome(heldAccount.id), id: heldAccount.id, reused: true };
    }
    const parent = optionalEnv(CODEX_SUPERVISOR_ID_ENV);
    const closed = new Set(living.filter((p) => p.id === parent || p.id.startsWith(PI_PRESENCE_PREFIX)).map((p) => p.accountId));
    const lent = countBy(living, (p) => p.accountId);
    const usable = idx.accounts.filter(
      (a) => !closed.has(a.id) && !rejected.has(a.id) && a.needsReauth !== true && !isExhausted(a, ctx) && codexStoreUsable(a.id)
    );
    const plan = usable.filter((a) => !onCredits(a, ctx));
    const open = plan.length > 0 ? plan : usable;
    const fewest = Math.min(...open.map((a) => lent[a.id] ?? 0));
    const picked = pickBest(open.filter((a) => (lent[a.id] ?? 0) === fewest), ctx);
    if (!picked) return null;
    const store = ensureCodexStoreHome(picked.id);
    writePresence({ dir: codexPaths.presenceDir, id: seatId, accountId: picked.id, pid });
    return { store, id: picked.id, reused: false };
  });
  if (granted && !("denied" in granted)) log("seat.grant", { account: granted.id.slice(0, 8), pid, reused: granted.reused });
  return granted;
}

export const codex: Provider = {
  name: "codex",
  flag: " --codex",
  pool: codexPool,
  seats: "live",
  waitsWhenDepleted: false,
  statusOnly: false,
  liveId,
  presence,
  planWeight: codexPlanWeight,
  gatedFamilies: () => null,
  heldFamilies: () => null,
  observeLive: (account, cfg, now, opts) => observeCodex(account, cfg, now, { probe: opts.probe, refresh: true }),
  samplePool,
  mergeWindows: (next) => next,
  swap: prepareMove,
  useBankedReset: async (a, signal) => {
    const fresh = await freshCodexAuth(a, Date.now(), false);
    return fresh.ok ? consumeCodexReset(fresh.auth, signal) : { reset: false, detail: fresh.reason };
  },
  classifySwapError: (e) => (e instanceof CodexInvalidGrantError ? "dead-grant" : e instanceof StoreUnusableError ? "skip" : "fatal"),
  removeCredentials: async (a) => {
    deleteCodexStoreAuth(a.id);
    deletePiStore("codex", a.id);
  },
  storeUsable: async (a) => codexStoreUsable(a.id),
  login,
  importLive,
  preflight,
  install,
  loginStep: (who) => `Open the URL codex prints, enter the code, and sign in with ${who}; the command exits once you're in.`,
  windowLabel: codexLimitLabel,
};
