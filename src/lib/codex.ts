import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV } from "./claudebin.ts";
import { codexIdentityOf, deleteParkedCodexAuth, isCodexAccessExpiring, liveCodexAccountId, readCodexAuthAt, readLiveCodexAuth, readParkedCodexAuth, writeLiveCodexAuth, writeParkedCodexAuth } from "./codexauth.ts";
import { resolveRealCodex, verifyRealCodex } from "./codexbin.ts";
import { CodexInvalidGrantError, CodexRefreshFailedError, refreshCodexAuth } from "./codexoauth.ts";
import { livingCodexPresences, presentCodexAccountIds } from "./codexpresence.ts";
import { CodexUsageReadError, codexLimitLabel, fetchCodexUsage } from "./codexusage.ts";
import { codexSupervisorLink, ensurePathInRc, installCodexSupervisor, managedShellRcSkipLines, shellRcPath } from "./install.ts";
import { withLock } from "./lock.ts";
import { log } from "./log.ts";
import { codexCredItemFor, codexPaths, codexPool } from "./paths.ts";
import { isExhausted, thresholdBars, type PickCtx } from "./picker.ts";
import type { Observation, Provider, SampleReport } from "./provider.ts";
import { loadAccounts, loadConfig, pinBinOverride, saveAccounts, saveLastSwapAt, type Harvest } from "./state.ts";
import { restoreTermios, saveTermios } from "./tty.ts";
import { CodexReconcileMarkerSchema, type Account, type CodexAuthJson, type CodexUsage, type Config } from "./types.ts";
import { c } from "../cli/render.ts";

function applyUsage(account: Account, usage: CodexUsage, at: number): void {
  account.windows = usage.windows;
  account.lastUsageAt = at;
  if (usage.email != null) account.email = usage.email;
  if (usage.planType != null) account.tier = usage.planType;
}

async function sampleLiveOntoOwner(now: number): Promise<void> {
  let live = readLiveCodexAuth();
  if (!live) return;
  const idx = loadAccounts(codexPool);
  const identity = codexIdentityOf({ auth: live });
  const owner = idx.accounts.find((a) => a.id === identity.accountId);
  if (!owner) return;

  if (isCodexAccessExpiring({ auth: live, now }) && !presentCodexAccountIds().has(identity.accountId)) {
    try {
      live = await refreshCodexAuth({ auth: live, now });
    } catch (e) {
      if (e instanceof CodexInvalidGrantError) {
        owner.needsReauth = true;
        saveAccounts(codexPool, idx);
        log("codex.live_invalid_grant", { account: owner.id.slice(0, 8) });
        return;
      }
      throw e;
    }
    writeLiveCodexAuth({ auth: live });
    writeParkedCodexAuth({ credFile: codexCredItemFor(owner.id), auth: live });
  }
  applyUsage(owner, await fetchCodexUsage({ auth: live, at: now }), now);
  saveAccounts(codexPool, idx);
}

async function observeLive(account: Account, cfg: Config, now: number, opts: { probe: boolean }): Promise<Observation | null> {
  if (opts.probe && (account.lastUsageAt == null || now - account.lastUsageAt > cfg.policy.usagePollTtlMs)) {
    await withLock(codexPool.lockFile, () => sampleLiveOntoOwner(now));
  }
  const fresh = loadAccounts(codexPool).accounts.find((a) => a.id === account.id);
  return fresh?.lastUsageAt != null ? { windows: fresh.windows, at: fresh.lastUsageAt } : null;
}

type CodexSampleOutcome = { ok: true; usage: CodexUsage; at: number } | { ok: false; reason: string; deadGrant: boolean };

async function sampleAccount(account: Account, liveId: string | null, now: number): Promise<CodexSampleOutcome> {
  const isLive = liveId != null && account.id === liveId;
  const credFile = codexCredItemFor(account.id);
  try {
    let auth = isLive ? readLiveCodexAuth() : readParkedCodexAuth({ credFile });
    if (!auth) return { ok: false, reason: isLive ? "live auth.json vanished" : "no parked credential", deadGrant: false };
    if (isCodexAccessExpiring({ auth, now })) {
      const running = presentCodexAccountIds().has(account.id);
      if (running && !isLive) {
        return { ok: false, reason: "running in a live codex session (parked token refresh unsafe)", deadGrant: false };
      }
      if (!running) {
        auth = await refreshCodexAuth({ auth, now });
        if (isLive) writeLiveCodexAuth({ auth });
        writeParkedCodexAuth({ credFile, auth });
      }
    }
    const at = Date.now();
    return { ok: true, usage: await fetchCodexUsage({ auth, at }), at };
  } catch (e) {
    if (e instanceof CodexInvalidGrantError) return { ok: false, reason: e.message, deadGrant: true };
    if (e instanceof CodexRefreshFailedError || e instanceof CodexUsageReadError) return { ok: false, reason: e.message, deadGrant: false };
    throw e;
  }
}

async function samplePool(accounts: Account[], liveId: string | null, now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(
    accounts.map(async (account) => {
      const outcome = await sampleAccount(account, liveId, now);
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

async function swap(target: Account): Promise<void> {
  const idx = loadAccounts(codexPool);
  const live = readLiveCodexAuth();
  let liveOwner: Account | null = null;
  if (live) {
    const liveIdentity = codexIdentityOf({ auth: live });
    liveOwner = idx.accounts.find((a) => a.id === liveIdentity.accountId) ?? null;
    if (!liveOwner) {
      throw new Error(
        `live codex credential belongs to ${liveIdentity.email ?? liveIdentity.accountId.slice(0, 8)}, which is not in the pool - refusing to swap over it; import it first with \`tokenmaxxing add --codex\``,
      );
    }
    if (liveOwner.id !== idx.activeId) {
      log("codexswap.harvest_drift", { labeled: idx.activeId?.slice(0, 8) ?? null, actual: liveOwner.id.slice(0, 8) });
    }
  }
  const commit = (): void => {
    idx.activeId = target.id;
    const entry = idx.accounts.find((a) => a.id === target.id);
    if (entry) entry.needsReauth = false;
    saveAccounts(codexPool, idx);
  };

  if (live && liveOwner && liveOwner.id === target.id) {
    writeParkedCodexAuth({ credFile: codexCredItemFor(target.id), auth: live });
    commit();
    log("codexswap.reconciled", { account: target.id.slice(0, 8) });
    return;
  }

  const parked = readParkedCodexAuth({ credFile: codexCredItemFor(target.id) });
  if (!parked) throw new Error(`no parked codex credential for ${target.label}`);

  let fresh: CodexAuthJson;
  try {
    fresh = await refreshCodexAuth({ auth: parked });
  } catch (e) {
    if (e instanceof CodexInvalidGrantError) {
      const entry = idx.accounts.find((a) => a.id === target.id);
      if (entry) {
        entry.needsReauth = true;
        saveAccounts(codexPool, idx);
      }
      log("codexswap.invalid_grant", { account: target.id.slice(0, 8) });
    }
    throw e;
  }
  writeParkedCodexAuth({ credFile: codexCredItemFor(target.id), auth: fresh });

  if (live && liveOwner) {
    const liveNow = readLiveCodexAuth();
    if (!liveNow || codexIdentityOf({ auth: liveNow }).accountId !== liveOwner.id) {
      throw new Error("live codex credential changed mid-swap - refusing to harvest under a stale identity; retry");
    }
    writeParkedCodexAuth({ credFile: codexCredItemFor(liveOwner.id), auth: liveNow });
    log("codexswap.harvest", { account: liveOwner.id.slice(0, 8) });
  }

  writeLiveCodexAuth({ auth: fresh });
  commit();
  saveLastSwapAt(codexPool, Date.now());
  log("codexswap.done", { account: target.id.slice(0, 8), label: target.label });
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
      park: async () => writeParkedCodexAuth({ credFile: codexCredItemFor(identity.accountId), auth }),
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
  const live = readLiveCodexAuth();
  if (!live) {
    console.error(c.red(`no codex login found at ${codexPaths.authJson} - run \`codex login\` first, then re-run this.`));
    return null;
  }
  const identity = codexIdentityOf({ auth: live });
  const usage = await sampleLogin(live);

  if (presentCodexAccountIds().has(identity.accountId)) {
    console.error(c.red("a live supervised codex session is running this account - its token rotates under us, so parking a snapshot now could poison the backup."));
    console.error(c.dim("close that codex session (or let it exit) and re-run `tokenmaxxing init --codex`."));
    return null;
  }

  return {
    id: identity.accountId,
    email: usage?.usage.email ?? identity.email,
    tier: usage?.usage.planType ?? identity.planType,
    sample: usage ? { windows: usage.usage.windows, at: usage.at } : null,
    park: async () => {
      if (presentCodexAccountIds().has(identity.accountId)) {
        throw new Error("a live supervised codex session started running this account mid-init - close it and re-run `tokenmaxxing init --codex`");
      }
      const fresh2 = readLiveCodexAuth();
      if (!fresh2 || codexIdentityOf({ auth: fresh2 }).accountId !== identity.accountId) {
        throw new Error("the live codex login changed while init was running (a concurrent swap?) - re-run `tokenmaxxing init --codex`");
      }
      writeParkedCodexAuth({ credFile: codexCredItemFor(identity.accountId), auth: fresh2 });
    },
  };
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
  console.log(c.bold(c.yellow("one manual step: codex skips untrusted hooks.")));
  console.log(c.yellow("open codex, run /hooks, and trust the tokenmaxxing Stop hook - auto-switching is inert until then."));
}

export function codexPickCtx(now: number, currentId: string | null): PickCtx {
  return { now, thresholds: thresholdBars(loadConfig()), currentId, families: null };
}

export function reconcileSiblings(now: number): void {
  const liveId = liveCodexAccountId();
  if (liveId == null) return;
  const idx = loadAccounts(codexPool);
  const liveAccount = idx.accounts.find((a) => a.id === liveId);
  if (!liveAccount || liveAccount.needsReauth === true || isExhausted(liveAccount, codexPickCtx(now, liveId))) return;
  const living = livingCodexPresences();
  if (existsSync(codexPaths.reconcileDir)) {
    const alive = new Set(living.map((presence) => presence.supervisorId));
    for (const name of readdirSync(codexPaths.reconcileDir)) {
      if (!alive.has(name)) rmSync(join(codexPaths.reconcileDir, name), { force: true });
    }
  }
  for (const presence of living) {
    if (presence.accountId === liveId) continue;
    if (!idx.accounts.some((a) => a.id === presence.accountId)) continue;
    const markerPath = join(codexPaths.reconcileDir, presence.supervisorId);
    if (existsSync(markerPath)) continue;
    mkdirSync(codexPaths.reconcileDir, { recursive: true });
    writeFileAtomic(markerPath, JSON.stringify(CodexReconcileMarkerSchema.parse({ accountId: presence.accountId, ts: now })));
    log("codex.reconcile_signal", { supervisorId: presence.supervisorId.slice(0, 8), account: presence.accountId.slice(0, 8) });
  }
}

export const codex: Provider = {
  name: "codex",
  flag: " --codex",
  pool: codexPool,
  waitsWhenDepleted: false,
  switchMargin: 1.2,
  switchNote: " (takes effect on the next codex start)",
  liveId: liveCodexAccountId,
  liveOwner: async () => liveCodexAccountId(),
  presentIds: presentCodexAccountIds,
  gatedFamilies: () => null,
  observeLive,
  samplePool,
  mergeWindows: (next) => next,
  swap,
  classifySwapError: (e) => (e instanceof CodexInvalidGrantError ? "dead-grant" : "fatal"),
  removeCredentials: async (a) => deleteParkedCodexAuth({ credFile: codexCredItemFor(a.id) }),
  login,
  importLive,
  preflight,
  install,
  loginStep: (who) => `Open the URL codex prints, enter the code, and sign in with ${who}; the command exits once you're in.`,
  windowLabel: codexLimitLabel,
};
