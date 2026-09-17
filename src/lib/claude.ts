import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readItem, writeItem, deleteItem, isolatedTarget, readStore, storeTarget, claudeAiOauthOnly } from "./credstore.ts";
import { resolveRealClaude, resolveVerifiedClaude } from "./claudebin.ts";
import { withClaudeRefreshLock } from "./claudelock.ts";
import { ensurePathInRc, installSupervisor, managedShellRcSkipLines, shellRcPath, timerActivationHint } from "./install.ts";
import { withLock } from "./lock.ts";
import { log } from "./log.ts";
import { claudeTierLabel, describeIdentity, fetchTokenIdentity, isDeadCredential, InvalidGrantError } from "./oauth.ts";
import { claudePool, paths, sampleDirFor, seatFromEnv, storeDirFor } from "./paths.ts";
import { pickBest, pickEarliestReset, thresholdBars, type PickCtx } from "./picker.ts";
import { seatCounts } from "./presence.ts";
import type { Observation, Provider, SampleReport } from "./provider.ts";
import { foldTee, sampleAccountUsage, teeObservation } from "./sample.ts";
import { clearUsageSnapshot, loadAccounts, loadConfig, loadUsageSnapshot, pinBinOverride, saveAccounts, type Harvest } from "./state.ts";
import { loadSetupTokens, saveSetupTokens } from "./setuptokens.ts";
import { saveTermios, restoreTermios } from "./tty.ts";
import { CRED_ENV_OVERRIDES, fetchUsageDirect, gatedFamilies, mergeWindows, windowsOf } from "./usage.ts";
import { CredentialBlobSchema, OAuthAccountSchema, type Account, type Config } from "./types.ts";
import { c } from "../cli/render.ts";

class StoreUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnusableError";
  }
}

function liveId(): string | null {
  return seatFromEnv(loadAccounts(claudePool).accounts.map((a) => a.id));
}

function presence(): Map<string, number> {
  return seatCounts(paths.presenceDir);
}

const PROBE_BACKOFF_CAP_MS = 30 * 60 * 1000;

async function observeLive(account: Account, cfg: Config, now: number, opts: { probe: boolean }): Promise<Observation | null> {
  const ttl = cfg.policy.usagePollTtlMs;
  const interval = Math.min(ttl * 2 ** (account.probeFails ?? 0), PROBE_BACKOFF_CAP_MS);
  const probeAttempted = account.lastProbeAt != null && now - account.lastProbeAt <= interval;
  const snap = loadUsageSnapshot(account.id);
  const fresh = snap != null && now - snap.at <= ttl;
  const needsPerModel = snap != null && gatedFamilies(snap.state.model, cfg.policy.switchModels).length > 0;
  if (opts.probe && !probeAttempted && (!fresh || needsPerModel)) {
    const startedAt = Date.now();
    const outcome = await sampleAccountUsage(account, { retries: 0 });
    await withLock(claudePool.lockFile, () => {
      const idx = loadAccounts(claudePool);
      const a = idx.accounts.find((x) => x.id === account.id);
      if (!a) return;
      a.lastProbeAt = startedAt;
      a.tier = account.tier;
      if (account.needsReauth) a.needsReauth = true;
      if (outcome.ok) {
        a.probeFails = 0;
        if (a.lastUsageAt == null || startedAt > a.lastUsageAt) {
          a.windows = mergeWindows(windowsOf(outcome.usage, startedAt), a.windows);
          a.lastUsageAt = startedAt;
        }
      } else {
        a.probeFails = (a.probeFails ?? 0) + 1;
      }
      saveAccounts(claudePool, idx);
    });
  }
  const current = loadAccounts(claudePool).accounts.find((a) => a.id === account.id) ?? account;
  return teeObservation(current);
}

async function samplePool(accounts: Account[]): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(
    accounts.map(async (a) => {
      const tee = loadUsageSnapshot(a.id);
      const teeAt = tee == null ? null : (tee.state.sampledAt ?? tee.state.ts);
      if (teeAt != null && (a.lastUsageAt == null || teeAt >= a.lastUsageAt)) {
        foldTee(a);
        reports.set(a.id, { ok: true, source: "statusline" });
        return;
      }
      const outcome = await sampleAccountUsage(a);
      if (!outcome.ok) {
        reports.set(a.id, { ok: false, reason: outcome.reason });
        return;
      }
      const at = Date.now();
      a.lastUsageAt = at;
      a.windows = mergeWindows(windowsOf(outcome.usage, at), a.windows);
      reports.set(a.id, { ok: true, source: "probe" });
    }),
  );
  return reports;
}

async function prepareMove(target: Account): Promise<void> {
  let creds;
  try {
    creds = await readStore(target.id);
  } catch (e) {
    throw new StoreUnusableError(`${target.label}'s store is unreadable (${e instanceof Error ? e.message : String(e)}) - re-auth with \`tokenmaxxing auth ${target.label}\``);
  }
  if (!creds) throw new StoreUnusableError(`${target.label} has no credential in its store - re-auth with \`tokenmaxxing auth ${target.label}\``);
  if (isDeadCredential(creds)) {
    const idx = loadAccounts(claudePool);
    const t = idx.accounts.find((a) => a.id === target.id);
    if (t) {
      t.needsReauth = true;
      saveAccounts(claudePool, idx);
    }
    log("move.invalid_grant", { account: target.id.slice(0, 8) });
    throw new InvalidGrantError(`${target.label}'s store was cleared after a failed refresh - re-auth with \`tokenmaxxing auth ${target.label}\``);
  }
  log("move.prepared", { account: target.id.slice(0, 8), label: target.label });
}

async function storeUsable(a: Account): Promise<boolean> {
  try {
    const creds = await readStore(a.id);
    return creds != null && !isDeadCredential(creds);
  } catch {
    return false;
  }
}

export function pickSeat(now: number): Account | null {
  const cfg = loadConfig();
  const idx = loadAccounts(claudePool);
  let dirty = false;
  for (const a of idx.accounts) dirty = foldTee(a) || dirty;
  if (dirty) saveAccounts(claudePool, idx);
  const ctx: PickCtx = { now, thresholds: thresholdBars(cfg), currentId: null, families: cfg.policy.switchModels, seats: presence() };
  return pickBest(idx.accounts, ctx) ?? pickEarliestReset(idx.accounts, ctx)?.account ?? null;
}

async function removeCredentials(a: Account): Promise<void> {
  await deleteItem(storeTarget(a.id));
  rmSync(storeDirFor(a.id), { recursive: true, force: true });
  rmSync(`${storeDirFor(a.id)}.lock`, { recursive: true, force: true });
  for (const dir of [sampleDirFor(a.id), sampleDirFor(a.id, "-tick")]) rmSync(dir, { recursive: true, force: true });
  clearUsageSnapshot(a.id);
  const setupTokens = loadSetupTokens();
  if (setupTokens.tokens.some((t) => t.accountUuid === a.id)) {
    saveSetupTokens({ ...setupTokens, tokens: setupTokens.tokens.filter((t) => t.accountUuid !== a.id) });
  }
}

function identityReady(cjPath: string): boolean {
  if (!existsSync(cjPath)) return false;
  try {
    const oauthAccount = JSON.parse(readFileSync(cjPath, "utf8")).oauthAccount;
    return z.object({ accountUuid: z.string().min(1) }).safeParse(oauthAccount).success;
  } catch {
    return false;
  }
}

async function login(): Promise<Harvest | null> {
  const onboardDir = paths.onboardDir;
  rmSync(onboardDir, { recursive: true, force: true });
  mkdirSync(onboardDir, { recursive: true });
  const iso = isolatedTarget(onboardDir);
  await deleteItem(iso);
  const cjPath = join(onboardDir, ".claude.json");
  const real = resolveRealClaude();

  const savedTermios = saveTermios();
  const env: Record<string, string> = { ...process.env, CLAUDE_CONFIG_DIR: onboardDir, TOKENMAXXING_PROBE: "1", TOKENMAXXING_SUPERVISED: "" };
  for (const key of CRED_ENV_OVERRIDES) delete env[key];
  const p = Bun.spawn([real], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });

  try {
    let exited = false;
    const onExit = p.exited.then(() => { exited = true; });
    while (!exited) {
      await Bun.sleep(400);
      if (identityReady(cjPath) && (await readItem(iso))) {
        p.kill();
        break;
      }
    }
    await p.exited;
    await onExit;
    restoreTermios(savedTermios);

    const blobRaw = await withClaudeRefreshLock(onboardDir, () => readItem(iso));
    if (!blobRaw || !identityReady(cjPath)) {
      console.error(c.red("no login detected in the isolated session - nothing changed."));
      return null;
    }

    let blob, oauthAccount;
    try {
      blob = CredentialBlobSchema.parse(JSON.parse(blobRaw));
      oauthAccount = OAuthAccountSchema.parse(JSON.parse(readFileSync(cjPath, "utf8")).oauthAccount);
    } catch {
      console.error(c.red("could not parse the onboarded account's credential/identity."));
      return null;
    }
    let identity;
    try {
      identity = await fetchTokenIdentity(blob.claudeAiOauth.accessToken);
    } catch (e) {
      console.error(c.red(`could not verify which account the login belongs to (${e instanceof Error ? e.message : String(e)}) - nothing changed.`));
      return null;
    }
    if (identity.accountUuid !== oauthAccount.accountUuid) {
      console.error(c.red(`the login's credential belongs to ${describeIdentity(identity)}, but its identity file names ${oauthAccount.emailAddress} - nothing changed.`));
      return null;
    }

    console.log(c.dim("sampling usage..."));
    const sampled = await fetchUsageDirect(blob.claudeAiOauth.accessToken);
    if (!sampled) console.log(c.yellow("could not sample usage now - it will fill in on first use."));
    const at = Date.now();
    const id = oauthAccount.accountUuid;
    return {
      id,
      email: oauthAccount.emailAddress,
      tier: claudeTierLabel(blob.claudeAiOauth),
      oauthAccount,
      sample: sampled ? { windows: windowsOf(sampled, at), at } : null,
      park: () => writeItem(storeTarget(id), claudeAiOauthOnly(blobRaw)),
    };
  } finally {
    if (p.exitCode === null) {
      p.kill();
      await p.exited;
    }
    restoreTermios(savedTermios);
    await deleteItem(iso);
    rmSync(onboardDir, { recursive: true, force: true });
  }
}

const loginStep = (who: string) => `In the session that opens, run  ${c.bold("/login")}  with ${who}. It closes itself once you're in.`;

async function importLive(): Promise<Harvest | null> {
  console.log(c.cyan("Opening an isolated login for your first pooled account - the login you already have stays as it is for sessions started outside the supervisor."));
  console.log(c.dim(loginStep("the first account to pool")));
  console.log();
  return login();
}

function ensurePathAhead(): void {
  const rc = shellRcPath();
  if (!rc) {
    console.log(c.yellow(`⚠ add to your shell rc: export PATH="${paths.binDir}:$PATH"`));
    return;
  }
  const outcome = ensurePathInRc(rc);
  if (outcome === "added") console.log(`${c.green("✓")} added ${paths.binDir} to PATH in ${rc} - restart your shell (or \`source ${rc}\`)`);
  else if (outcome === "skipped") {
    const hint = managedShellRcSkipLines();
    console.log(c.yellow(`⚠ ${hint.headline}`));
    console.log(c.yellow(`  ${hint.detail}`));
    console.log(c.yellow(`  ${hint.exportLine}`));
  } else console.log(c.yellow(`⚠ PATH line already in ${rc} - restart your shell to pick it up`));
}

function install(): void {
  const out = installSupervisor();
  console.log(`${c.green("✓")} installed ${c.bold("claude")} supervisor + statusLine/Stop/StopFailure/SessionStart hooks`);
  if (out.timerLoaded) console.log(`${c.green("✓")} periodic check timer active (every ${out.checkIntervalS}s)`);
  else console.log(c.yellow(`⚠ check timer written but not activated - run: ${timerActivationHint()}`));
  if (!out.pathAhead) {
    console.log();
    ensurePathAhead();
  }
}

export const claude: Provider = {
  name: "claude",
  flag: "",
  pool: claudePool,
  seats: "shared",
  waitsWhenDepleted: true,
  statusOnly: false,
  liveId,
  presence,
  gatedFamilies: (cfg) => {
    const seat = liveId();
    return gatedFamilies(seat == null ? null : (loadUsageSnapshot(seat)?.state.model ?? null), cfg.policy.switchModels);
  },
  observeLive,
  samplePool,
  mergeWindows,
  swap: prepareMove,
  classifySwapError: (e) => (e instanceof InvalidGrantError ? "dead-grant" : e instanceof StoreUnusableError ? "skip" : "fatal"),
  removeCredentials,
  storeUsable,
  login,
  importLive,
  preflight: () => pinBinOverride({ key: "claudeBin", bin: resolveVerifiedClaude() }),
  install,
  loginStep,
  windowLabel: (name) => name.toLowerCase(),
};
