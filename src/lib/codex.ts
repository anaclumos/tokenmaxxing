import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { minBy } from "es-toolkit";
import { writeFileAtomic } from "./atomic.ts";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV } from "./claudebin.ts";
import { codexIdentityOf, isCodexAccessExpiring, isDeadCodexCredential, readCodexAuthAt, readCodexStore, writeCodexStore } from "./codexauth.ts";
import { resolveRealCodex, verifyRealCodex } from "./codexbin.ts";
import { CodexInvalidGrantError, CodexRefreshFailedError, refreshCodexAuth } from "./codexoauth.ts";
import { seatCounts } from "./presence.ts";
import { CodexUsageReadError, codexLimitLabel, fetchCodexUsage } from "./codexusage.ts";
import { codexSupervisorLink, ensurePathInRc, installCodexSupervisor, managedShellRcSkipLines, shellRcPath } from "./install.ts";
import { withLock } from "./lock.ts";
import { log } from "./log.ts";
import { codexPaths, codexPool, codexSeatFromEnv, codexStoreDirFor } from "./paths.ts";
import type { Observation, Provider, SampleReport } from "./provider.ts";
import { loadAccounts, pinBinOverride, saveAccounts, type Harvest } from "./state.ts";
import { restoreTermios, saveTermios } from "./tty.ts";
import type { Account, CodexAuthJson, CodexUsage, Config } from "./types.ts";
import { c } from "../cli/render.ts";

class StoreUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnusableError";
  }
}

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

type PreparedToken = { ok: true; auth: CodexAuthJson } | { ok: false; reason: string; deadGrant: boolean };

async function prepareToken(account: Account, now: number): Promise<PreparedToken> {
  let auth: CodexAuthJson | null;
  try {
    auth = readCodexStore(account.id);
  } catch (e) {
    return { ok: false, reason: `store credential unreadable (${(e instanceof Error ? e.message : String(e)).slice(0, 80)}) - run \`tokenmaxxing auth --codex\``, deadGrant: false };
  }
  if (!auth) return { ok: false, reason: "no credential in this account's store - run `tokenmaxxing auth --codex`", deadGrant: false };
  if (isDeadCodexCredential(auth)) return { ok: false, reason: "the store's credential is empty - re-auth with `tokenmaxxing auth --codex`", deadGrant: true };
  if (!isCodexAccessExpiring({ auth, now }) || presence().has(account.id)) return { ok: true, auth };
  try {
    auth = await refreshCodexAuth({ auth, now });
  } catch (e) {
    if (e instanceof CodexInvalidGrantError) return { ok: false, reason: e.message, deadGrant: true };
    if (e instanceof CodexRefreshFailedError) return { ok: false, reason: e.message, deadGrant: false };
    throw e;
  }
  writeCodexStore({ accountId: account.id, auth });
  log("codex.store_refreshed", { account: account.id.slice(0, 8) });
  return { ok: true, auth };
}

type UsageOutcome = { ok: true; usage: CodexUsage; at: number } | { ok: false; reason: string };

async function fetchUsageOutcome(auth: CodexAuthJson): Promise<UsageOutcome> {
  const at = Date.now();
  try {
    return { ok: true, usage: await fetchCodexUsage({ auth, at }), at };
  } catch (e) {
    if (e instanceof CodexUsageReadError) return { ok: false, reason: e.message };
    throw e;
  }
}

function storeOutcome(accountId: string, outcome: UsageOutcome): void {
  const idx = loadAccounts(codexPool);
  const a = idx.accounts.find((x) => x.id === accountId);
  if (!a) return;
  if (outcome.ok && (a.lastUsageAt == null || outcome.at > a.lastUsageAt)) {
    applyUsage(a, outcome.usage, outcome.at);
    saveAccounts(codexPool, idx);
  }
  log(outcome.ok ? "codex.sample_ok" : "codex.sample_failed", {
    account: accountId.slice(0, 8),
    ...(outcome.ok ? {} : { reason: outcome.reason.slice(0, 200) }),
  });
}

async function reserveToken(accountId: string, now: number): Promise<CodexAuthJson | null> {
  const idx = loadAccounts(codexPool);
  const a = idx.accounts.find((x) => x.id === accountId);
  if (!a) return null;
  a.lastProbeAt = now;
  const prepared = await prepareToken(a, now);
  if (!prepared.ok && prepared.deadGrant) a.needsReauth = true;
  saveAccounts(codexPool, idx);
  if (!prepared.ok) {
    log("codex.sample_failed", { account: accountId.slice(0, 8), reason: prepared.reason.slice(0, 200) });
    return null;
  }
  return prepared.auth;
}

const attemptedAt = (a: Account): number => Math.max(a.lastUsageAt ?? 0, a.lastProbeAt ?? 0);

async function observeLive(account: Account, cfg: Config, now: number, opts: { probe: boolean }): Promise<Observation | null> {
  if (opts.probe && now - attemptedAt(account) > cfg.policy.usagePollTtlMs) {
    const auth = await withLock(codexPool.lockFile, () => reserveToken(account.id, now));
    if (auth) {
      const outcome = await fetchUsageOutcome(auth);
      await withLock(codexPool.lockFile, () => storeOutcome(account.id, outcome));
    }
  }
  const fresh = loadAccounts(codexPool).accounts.find((a) => a.id === account.id);
  return fresh?.lastUsageAt != null ? { windows: fresh.windows, at: fresh.lastUsageAt } : null;
}

async function samplePool(accounts: Account[], now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(
    accounts.map(async (account) => {
      const prepared = await prepareToken(account, now);
      if (!prepared.ok) {
        if (prepared.deadGrant) account.needsReauth = true;
        reports.set(account.id, { ok: false, reason: prepared.reason });
        return;
      }
      const outcome = await fetchUsageOutcome(prepared.auth);
      if (outcome.ok) {
        applyUsage(account, outcome.usage, outcome.at);
        reports.set(account.id, { ok: true, source: "probe" });
      } else {
        reports.set(account.id, { ok: false, reason: outcome.reason });
      }
    }),
  );
  return reports;
}

async function sampleOldest(cfg: Config): Promise<void> {
  const reserved = await withLock(codexPool.lockFile, async () => {
    const now = Date.now();
    const stale = loadAccounts(codexPool).accounts.filter((a) => a.needsReauth !== true && now - attemptedAt(a) > cfg.policy.usagePollTtlMs);
    const target = minBy(stale, attemptedAt);
    if (!target) return null;
    const auth = await reserveToken(target.id, now);
    return auth ? { id: target.id, auth } : null;
  });
  if (!reserved) return;
  const outcome = await fetchUsageOutcome(reserved.auth);
  await withLock(codexPool.lockFile, () => storeOutcome(reserved.id, outcome));
}

async function prepareMove(target: Account): Promise<void> {
  const prepared = await prepareToken(target, Date.now());
  if (prepared.ok) {
    log("codexmove.prepared", { account: target.id.slice(0, 8), label: target.label });
    return;
  }
  if (prepared.deadGrant) {
    const idx = loadAccounts(codexPool);
    const t = idx.accounts.find((a) => a.id === target.id);
    if (t) {
      t.needsReauth = true;
      saveAccounts(codexPool, idx);
    }
    log("codexmove.invalid_grant", { account: target.id.slice(0, 8) });
    throw new CodexInvalidGrantError(`${target.label}: ${prepared.reason}`);
  }
  throw new StoreUnusableError(`${target.label}: ${prepared.reason}`);
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
      park: async () => writeCodexStore({ accountId: identity.accountId, auth }),
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
  console.log(c.cyan("Opening an isolated codex login for your first pooled account - the login you already have stays as it is for codex started outside the supervisor."));
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
      `codex config.toml pins cli_auth_credentials_store away from the plain auth.json file a pooled account's store holds - set cli_auth_credentials_store = "file" in ${codexPaths.configToml}, then re-run this.`,
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
  console.log(c.yellow("open codex, run /hooks, and trust the tokenmaxxing Stop hook once - every pooled account's store picks the grant up on its next launch."));
}

async function removeCredentials(a: Account): Promise<void> {
  rmSync(codexStoreDirFor(a.id), { recursive: true, force: true });
}

export const codex: Provider = {
  name: "codex",
  flag: " --codex",
  pool: codexPool,
  waitsWhenDepleted: false,
  liveId,
  presence,
  gatedFamilies: () => null,
  observeLive,
  samplePool,
  sampleOldest,
  mergeWindows: (next) => next,
  swap: prepareMove,
  classifySwapError: (e) => (e instanceof CodexInvalidGrantError ? "dead-grant" : e instanceof StoreUnusableError ? "skip" : "fatal"),
  removeCredentials,
  login,
  importLive,
  preflight,
  install,
  loginStep,
  windowLabel: codexLimitLabel,
};
