import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV } from "./claudebin.ts";
import { codexIdentityOf, deleteCodexStore, isCodexAccessExpiring, readCodexAuthAt, readCodexStore, writeCodexStore } from "./codexauth.ts";
import { resolveRealCodex, verifyRealCodex } from "./codexbin.ts";
import { CodexInvalidGrantError, CodexRefreshFailedError, refreshCodexAuth } from "./codexoauth.ts";
import { seatCounts } from "./presence.ts";
import { CodexUsageReadError, codexLimitLabel, fetchCodexUsage } from "./codexusage.ts";
import { codexSupervisorLink, ensurePathInRc, installCodexSupervisor, managedShellRcSkipLines, shellRcPath } from "./install.ts";
import { withLock } from "./lock.ts";
import { log } from "./log.ts";
import { codexPaths, codexPool, codexSeatFromEnv } from "./paths.ts";
import { pickBest, thresholdBars, type PickCtx } from "./picker.ts";
import { StoreUnusableError, type Observation, type Provider, type SampleReport } from "./provider.ts";
import { loadAccounts, loadConfig, pinBinOverride, saveAccounts, type Harvest } from "./state.ts";
import { restoreTermios, saveTermios } from "./tty.ts";
import type { Account, CodexAuthJson, CodexUsage, Config } from "./types.ts";
import { c } from "../cli/render.ts";

function applyUsage(account: Account, usage: CodexUsage, at: number): void {
  account.windows = usage.windows;
  account.lastUsageAt = at;
  if (usage.email != null) account.email = usage.email;
  if (usage.planType != null) account.tier = usage.planType;
}

function liveId(): string | null {
  return codexSeatFromEnv(loadAccounts(codexPool).accounts.map((a) => a.id));
}

function presence(): Map<string, number> {
  return seatCounts(codexPaths.presenceDir);
}

type CodexSampleOutcome = { ok: true; usage: CodexUsage; at: number } | { ok: false; reason: string; deadGrant: boolean };

async function sampleAccount(account: Account, present: Map<string, number>, now: number): Promise<CodexSampleOutcome> {
  try {
    let auth = readCodexStore(account.id);
    if (!auth) return { ok: false, reason: "no credential in this account's store - run `tokenmaxxing auth --codex`", deadGrant: false };
    if (isCodexAccessExpiring({ auth, now }) && !present.has(account.id)) {
      auth = await refreshCodexAuth({ auth, now });
      writeCodexStore(account.id, auth);
    }
    const at = Date.now();
    return { ok: true, usage: await fetchCodexUsage({ auth, at }), at };
  } catch (e) {
    if (e instanceof CodexInvalidGrantError) return { ok: false, reason: e.message, deadGrant: true };
    if (e instanceof CodexRefreshFailedError || e instanceof CodexUsageReadError) return { ok: false, reason: e.message, deadGrant: false };
    throw e;
  }
}

async function observeLive(account: Account, cfg: Config, now: number, opts: { probe: boolean }): Promise<Observation | null> {
  if (opts.probe && (account.lastUsageAt == null || now - account.lastUsageAt > cfg.policy.usagePollTtlMs)) {
    await withLock(codexPool.lockFile, async () => {
      const idx = loadAccounts(codexPool);
      const stored = idx.accounts.find((a) => a.id === account.id);
      if (!stored) return;
      const outcome = await sampleAccount(stored, presence(), now);
      if (outcome.ok) applyUsage(stored, outcome.usage, outcome.at);
      else if (outcome.deadGrant) stored.needsReauth = true;
      saveAccounts(codexPool, idx);
      if (!outcome.ok) log("codex.observe_failed", { account: account.id.slice(0, 8), reason: outcome.reason.slice(0, 200) });
    });
  }
  const fresh = loadAccounts(codexPool).accounts.find((a) => a.id === account.id);
  return fresh?.lastUsageAt != null ? { windows: fresh.windows, at: fresh.lastUsageAt } : null;
}

async function samplePool(accounts: Account[], now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  const present = presence();
  await Promise.all(
    accounts.map(async (account) => {
      const outcome = await sampleAccount(account, present, now);
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
    auth = readCodexStore(target.id);
  } catch (e) {
    throw new StoreUnusableError(`${target.label}'s store is unreadable (${e instanceof Error ? e.message : String(e)}) - re-auth with \`tokenmaxxing auth --codex ${target.label}\``);
  }
  if (!auth) throw new StoreUnusableError(`${target.label} has no credential in its store - re-auth with \`tokenmaxxing auth --codex ${target.label}\``);
  log("codexmove.prepared", { account: target.id.slice(0, 8) });
}

async function storeUsable(a: Account): Promise<boolean> {
  try {
    return readCodexStore(a.id) != null;
  } catch {
    return false;
  }
}

export function pickCodexSeat(now: number): Account | null {
  const cfg = loadConfig();
  const idx = loadAccounts(codexPool);
  const present = presence();
  const ctx: PickCtx = { now, thresholds: thresholdBars(cfg), currentId: null, families: null, seats: null };
  return pickBest(idx.accounts.filter((a) => !present.has(a.id)), ctx);
}

async function login(): Promise<Harvest | null> {
  const real = resolveRealCodex();
  const onboardDir = codexPaths.onboardDir;
  rmSync(onboardDir, { recursive: true, force: true });
  mkdirSync(onboardDir, { recursive: true });
  writeFileAtomic(join(onboardDir, "config.toml"), 'cli_auth_credentials_store = "file"\n');

  const env: Record<string, string | undefined> = {
    ...process.env,
    CODEX_HOME: onboardDir,
    TOKENMAXXING_PROBE: "1",
    [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH),
  };
  delete env.CODEX_SQLITE_HOME;

  const savedTermios = saveTermios();
  const p = Bun.spawn([real, "login", "--device-auth"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
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
      park: async () => writeCodexStore(identity.accountId, auth),
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

const loginStep = (who: string) => `Open the URL codex prints, enter the code, and sign in with ${who}; the command exits once you're in.`;

async function importLive(): Promise<Harvest | null> {
  console.log(c.cyan("Opening an isolated codex login for your first pooled account - the login you already have stays as it is for sessions started outside the supervisor."));
  console.log(c.dim(loginStep("the first account to pool")));
  console.log();
  return login();
}

function storePinnedAwayFromFile(): boolean {
  if (!existsSync(codexPaths.configToml)) return false;
  const config = Bun.TOML.parse(readFileSync(codexPaths.configToml, "utf8"));
  return "cli_auth_credentials_store" in config && config.cli_auth_credentials_store !== "file";
}

function preflight(): void {
  const real = resolveRealCodex();
  const fail = verifyRealCodex({ bin: real });
  if (fail !== null) throw new Error(`codex binary failed verification: ${real}: ${fail}`);
  pinBinOverride({ key: "codexBin", bin: real });
  if (storePinnedAwayFromFile()) {
    throw new Error(
      `codex config.toml pins cli_auth_credentials_store away from the auth.json file each pooled account's codex home holds - set cli_auth_credentials_store = "file" in ${codexPaths.configToml}, then re-run this.`,
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
  console.log(c.bold(c.yellow("one manual step: codex skips untrusted hooks.")));
  console.log(c.yellow("open codex, run /hooks, and trust the tokenmaxxing Stop hook - auto-switching is inert until then."));
  console.log(c.dim("the trust you grant once is copied to every pooled account's codex home at launch."));
}

export const codex: Provider = {
  name: "codex",
  flag: " --codex",
  pool: codexPool,
  seats: "live",
  waitsWhenDepleted: false,
  liveId,
  presence,
  gatedFamilies: () => null,
  observeLive,
  samplePool,
  mergeWindows: (next) => next,
  swap: prepareMove,
  classifySwapError: (e) => (e instanceof StoreUnusableError ? "skip" : "fatal"),
  removeCredentials: async (a) => deleteCodexStore(a.id),
  storeUsable,
  login,
  importLive,
  preflight,
  install,
  loginStep,
  windowLabel: codexLimitLabel,
};
