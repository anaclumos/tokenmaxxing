import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV } from "./claudebin.ts";
import { codexIdentityOf, codexStoreUsable, deleteCodexStoreAuth, isCodexAccessExpiring, readCodexAuthAt, readCodexStoreAuth, writeCodexStoreAuth } from "./codexauth.ts";
import { resolveRealCodex, verifyRealCodex } from "./codexbin.ts";
import { CodexInvalidGrantError, CodexRefreshFailedError, refreshCodexAuth } from "./codexoauth.ts";
import { seatCounts } from "./presence.ts";
import { CodexUsageReadError, codexLimitLabel, fetchCodexUsage } from "./codexusage.ts";
import { codexSupervisorLink, ensurePathInRc, installCodexSupervisor, managedShellRcSkipLines, shellRcPath } from "./install.ts";
import { withLock } from "./lock.ts";
import { errorMessage, log } from "./log.ts";
import { codexPaths, codexPool, codexSeatFromEnv } from "./paths.ts";
import { isExhausted, pickBest, pickEarliestReset, thresholdBars, type PickCtx } from "./picker.ts";
import { StoreUnusableError, type Observation, type Provider, type SampleReport } from "./provider.ts";
import { loadAccounts, loadConfig, pinBinOverride, saveAccounts, type Harvest } from "./state.ts";
import { restoreTermios, saveTermios } from "./tty.ts";
import type { Account, CodexAuthJson, CodexUsage, Config } from "./types.ts";
import { c } from "../cli/render.ts";

function liveId(): string | null {
  return codexSeatFromEnv(loadAccounts(codexPool).accounts.map((a) => a.id));
}

function presence(): Map<string, number> {
  return seatCounts(codexPaths.presenceDir);
}

function applyUsage(account: Account, usage: CodexUsage, at: number): void {
  account.windows = usage.windows;
  account.lastUsageAt = at;
  if (usage.email != null) account.email = usage.email;
  if (usage.planType != null) account.tier = usage.planType;
}

type CodexReadOutcome = { ok: true; usage: CodexUsage; at: number } | { ok: false; reason: string; deadGrant: boolean };

async function readCodexUsage(account: Account, now: number, refresh: boolean): Promise<CodexReadOutcome> {
  let auth: CodexAuthJson | null;
  try {
    auth = readCodexStoreAuth(account.id);
  } catch (e) {
    return { ok: false, reason: `store credential unreadable (${errorMessage(e).slice(0, 80)})`, deadGrant: false };
  }
  if (!auth) return { ok: false, reason: "no credential in this account's store - run `tokenmaxxing auth --codex`", deadGrant: false };
  try {
    if (isCodexAccessExpiring({ auth, now })) {
      if (!refresh) {
        return { ok: false, reason: "stored access token is expiring and this read never refreshes a store", deadGrant: false };
      }
      if (seatCounts(codexPaths.presenceDir).has(account.id)) {
        return { ok: false, reason: "running in a live codex session (store refresh unsafe)", deadGrant: false };
      }
      auth = await refreshCodexAuth({ auth, now });
      writeCodexStoreAuth(account.id, auth);
    }
    const at = Date.now();
    return { ok: true, usage: await fetchCodexUsage({ auth, at }), at };
  } catch (e) {
    if (e instanceof CodexInvalidGrantError) return { ok: false, reason: e.message, deadGrant: true };
    if (e instanceof CodexRefreshFailedError || e instanceof CodexUsageReadError) return { ok: false, reason: e.message, deadGrant: false };
    throw e;
  }
}

export async function observeCodex(account: Account, cfg: Config, now: number, opts: { probe: boolean; refresh: boolean }): Promise<Observation | null> {
  if (opts.probe && (account.lastUsageAt == null || now - account.lastUsageAt > cfg.policy.usagePollTtlMs)) {
    const outcome = await readCodexUsage(account, now, opts.refresh);
    await withLock(codexPool.lockFile, () => {
      const idx = loadAccounts(codexPool);
      const a = idx.accounts.find((x) => x.id === account.id);
      if (!a) return;
      if (outcome.ok) {
        if (a.lastUsageAt == null || outcome.at > a.lastUsageAt) {
          applyUsage(a, outcome.usage, outcome.at);
        }
      } else if (outcome.deadGrant) {
        a.needsReauth = true;
      }
      saveAccounts(codexPool, idx);
    });
  }
  const current = loadAccounts(codexPool).accounts.find((a) => a.id === account.id) ?? account;
  return current.lastUsageAt != null ? { windows: current.windows, at: current.lastUsageAt } : null;
}

async function samplePool(accounts: Account[], _liveId: string | null, now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(
    accounts.map(async (account) => {
      const outcome = await readCodexUsage(account, now, true);
      if (outcome.ok) {
        applyUsage(account, outcome.usage, outcome.at);
        reports.set(account.id, { ok: true, source: "probe" });
      } else {
        if (outcome.deadGrant) account.needsReauth = true;
        reports.set(account.id, { ok: false, reason: outcome.reason });
      }
    }),
  );
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
  const real = resolveRealCodex();
  const onboardDir = codexPaths.onboardDir;
  rmSync(onboardDir, { recursive: true, force: true });
  mkdirSync(onboardDir, { recursive: true });
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
      id: identity.accountId,
      email: usage?.usage.email ?? identity.email,
      tier: usage?.usage.planType ?? identity.planType,
      sample: usage ? { windows: usage.usage.windows, at: usage.at } : null,
      park: async () => writeCodexStoreAuth(identity.accountId, auth),
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

function storePinnedAwayFromFile(): boolean {
  const configToml = `${codexPaths.home}/config.toml`;
  if (!existsSync(configToml)) return false;
  const config = Bun.TOML.parse(readFileSync(configToml, "utf8"));
  return "cli_auth_credentials_store" in config && config.cli_auth_credentials_store !== "file";
}

function preflight(): void {
  const real = resolveRealCodex();
  const fail = verifyRealCodex({ bin: real });
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

export function codexPickCtx(now: number, currentId: string | null): PickCtx {
  return { now, thresholds: thresholdBars(loadConfig()), currentId, families: null, seats: null };
}

export function pickCodexSeat(now: number): Account | null {
  const ctx = codexPickCtx(now, null);
  const present = seatCounts(codexPaths.presenceDir);
  const open = loadAccounts(codexPool).accounts.filter((a) => a.needsReauth !== true && !present.has(a.id) && codexStoreUsable(a.id));
  return pickBest(open.filter((a) => !isExhausted(a, ctx)), ctx) ?? pickEarliestReset(open, ctx)?.account ?? null;
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
  gatedFamilies: () => null,
  observeLive: (account, cfg, now, opts) => observeCodex(account, cfg, now, { probe: opts.probe, refresh: true }),
  samplePool,
  mergeWindows: (next) => next,
  swap: prepareMove,
  classifySwapError: (e) => (e instanceof CodexInvalidGrantError ? "dead-grant" : e instanceof StoreUnusableError ? "skip" : "fatal"),
  removeCredentials: async (a) => deleteCodexStoreAuth(a.id),
  storeUsable: async (a) => codexStoreUsable(a.id),
  login,
  importLive,
  preflight,
  install,
  loginStep: (who) => `Open the URL codex prints, enter the code, and sign in with ${who}; the command exits once you're in.`,
  windowLabel: codexLimitLabel,
};
