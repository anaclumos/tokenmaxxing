import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readItem, writeItem, deleteItem, liveTarget, parkedTarget, isolatedTarget, claudeAiOauthOnly, mergeIntoLive } from "./credstore.ts";
import { resolveRealClaude, resolveVerifiedClaude } from "./claudebin.ts";
import { withClaudeRefreshLock } from "./claudelock.ts";
import { isApiKeyMode, readOAuthAccount } from "./claudejson.ts";
import { ensurePathInRc, installSupervisor, managedShellRcSkipLines, shellRcPath, timerActivationHint } from "./install.ts";
import { withLock } from "./lock.ts";
import { log } from "./log.ts";
import { claudeTierLabel, describeIdentity, fetchTokenIdentity, isAccessTokenExpiring, isDeadCredential, refreshCredential, InvalidGrantError } from "./oauth.ts";
import { claudePool, credItemFor, paths } from "./paths.ts";
import type { Observation, Provider, SampleReport } from "./provider.ts";
import { ensureLiveTokenFresh, probeActiveUsage, probeParkedUsage } from "./sample.ts";
import { loadAccounts, loadUsage, loadUsageSnapshot, pinBinOverride, saveAccounts, writeUsage, type Harvest } from "./state.ts";
import { isSkippableSwapError, performSwap } from "./swap.ts";
import { loadSetupTokens, saveSetupTokens } from "./setuptokens.ts";
import { saveTermios, restoreTermios } from "./tty.ts";
import { CRED_ENV_OVERRIDES, familyTokens, gatedFamilies, mergeWindows, probeUsage, windowsOf } from "./usage.ts";
import { CredentialBlobSchema, OAuthAccountSchema, type Account, type Config, type UsageState } from "./types.ts";
import { c } from "../cli/render.ts";

function teeObservation(account: Account, snap: { state: UsageState; at: number } | null): Observation | null {
  if (!snap || snap.state.account !== account.id) return null;
  if (account.lastUsageAt != null && snap.at < account.lastUsageAt) return { windows: account.windows, at: account.lastUsageAt };
  const at = snap.state.sampledAt ?? snap.at;
  const aggregate = windowsOf({ fiveHour: snap.state.fiveHour, sevenDay: snap.state.sevenDay, perModel: {} }, at);
  return { windows: mergeWindows(aggregate, account.windows), at };
}

async function observeLive(account: Account, cfg: Config, now: number, opts: { probe: boolean }): Promise<Observation | null> {
  let snap = loadUsageSnapshot();
  const ttl = cfg.policy.usagePollTtlMs;
  const probeAttempted = account.lastProbeAt != null && now - account.lastProbeAt <= ttl;
  const fresh = snap != null && snap.state.account === account.id && now - snap.at <= ttl;
  const needsPerModel = snap != null && gatedFamilies(snap.state.model, cfg.policy.switchModels).length > 0;
  if (opts.probe && !probeAttempted && (!fresh || needsPerModel)) {
    const startedAt = Date.now();
    const full = await probeUsage();
    const ts = Date.now();
    if (readOAuthAccount()?.accountUuid === account.id) {
      if (full) {
        const teed = loadUsageSnapshot();
        if (teed && teed.state.account === account.id && ts - teed.at <= ttl) {
          snap = teed;
        } else {
          const state: UsageState = { fiveHour: full.fiveHour, sevenDay: full.sevenDay, account: account.id, ts, model: null };
          writeUsage(state);
          snap = { state, at: ts };
        }
        const expected = gatedFamilies(snap.state.model, cfg.policy.switchModels);
        const rows = Object.keys(full.perModel);
        if (expected.length > 0 && !expected.some((f) => rows.some((k) => familyTokens(k).includes(f)))) {
          log("usage.no_permodel_row", { families: expected.join(","), rows: rows.join(",") });
        }
      }
      await withLock(claudePool.lockFile, () => {
        const idx = loadAccounts(claudePool);
        const a = idx.accounts.find((x) => x.id === account.id);
        if (!a) return;
        a.lastProbeAt = startedAt;
        if (full) {
          const probed = windowsOf(full, startedAt);
          const aggregate = a.windows.some((w) => w.name == null) ? a.windows.filter((w) => w.name == null) : probed.filter((w) => w.name == null);
          if (a.lastUsageAt == null) a.lastUsageAt = startedAt;
          a.windows = mergeWindows([...aggregate, ...probed.filter((w) => w.name != null)], a.windows);
        }
        saveAccounts(claudePool, idx);
      });
    }
  }
  const current = loadAccounts(claudePool).accounts.find((a) => a.id === account.id) ?? account;
  return teeObservation(current, snap);
}

async function samplePool(accounts: Account[], liveId: string | null): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  const tee = loadUsageSnapshot();
  const probeOne = async (a: Account): Promise<void> => {
    const isActive = liveId != null && liveId === a.id;
    const teeCurrent = tee != null && (a.lastUsageAt == null || tee.at >= a.lastUsageAt);
    if (isActive && tee && teeCurrent && tee.state.account === a.id) {
      const at = tee.state.sampledAt ?? tee.at;
      a.lastUsageAt = at;
      a.windows = mergeWindows(windowsOf({ fiveHour: tee.state.fiveHour, sevenDay: tee.state.sevenDay, perModel: {} }, at), a.windows);
      reports.set(a.id, { ok: true, source: "statusline" });
      return;
    }
    const outcome = isActive ? await probeActiveUsage(a) : await probeParkedUsage(a);
    if (!outcome.ok) {
      reports.set(a.id, { ok: false, reason: outcome.reason });
      return;
    }
    const at = Date.now();
    a.lastUsageAt = at;
    a.windows = mergeWindows(windowsOf(outcome.usage, at), a.windows);
    reports.set(a.id, { ok: true, source: "probe" });
  };
  const active = accounts.find((a) => liveId != null && liveId === a.id) ?? null;
  if (active) await probeOne(active);
  try {
    await ensureLiveTokenFresh();
  } catch {
  }
  await Promise.all(accounts.filter((a) => a !== active).map(probeOne));
  return reports;
}

async function liveOwner(): Promise<string | null> {
  const live = await readItem(liveTarget());
  if (live == null) return null;
  const creds = CredentialBlobSchema.parse(JSON.parse(live)).claudeAiOauth;
  return (await fetchTokenIdentity(creds.accessToken)).accountUuid;
}

async function removeCredentials(a: Account): Promise<void> {
  const setupTokens = loadSetupTokens();
  const item = credItemFor(a.id);
  await deleteItem(parkedTarget(item));
  for (const sampleDir of [join(paths.sampleDir, item), join(paths.sampleDir, `${item}-tick`)]) {
    await deleteItem(isolatedTarget(sampleDir));
    rmSync(sampleDir, { recursive: true, force: true });
  }
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

    const blobRaw = await readItem(iso);
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

    console.log(c.dim("sampling usage..."));
    const sampled = await probeUsage(onboardDir);
    if (!sampled) console.log(c.yellow("could not sample usage now - it will fill in on first use."));
    const at = Date.now();
    const id = oauthAccount.accountUuid;
    return {
      id,
      email: oauthAccount.emailAddress,
      tier: claudeTierLabel(blob.claudeAiOauth),
      oauthAccount,
      sample: sampled ? { windows: windowsOf(sampled, at), at } : null,
      park: () => writeItem(parkedTarget(credItemFor(id)), claudeAiOauthOnly(blobRaw)),
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

async function importLive(): Promise<Harvest | null> {
  if (isApiKeyMode()) {
    console.error(c.yellow("tokenmaxxing pools subscription accounts, but you're authed via API key / apiKeyHelper."));
    console.error(`Run ${c.cyan("claude")} → ${c.cyan("/login")} with a Pro/Max account first, then re-run ${c.cyan("tokenmaxxing init")}.`);
    return null;
  }

  const oauthAccount = readOAuthAccount();
  const liveRaw = await readItem(liveTarget());
  if (!oauthAccount || !liveRaw) {
    console.error(c.red("no active Claude subscription login found (missing oauthAccount or credential)."));
    console.error(`Run ${c.cyan("claude")} → ${c.cyan("/login")} first, then re-run ${c.cyan("tokenmaxxing init")}.`);
    return null;
  }

  let blob;
  try {
    blob = CredentialBlobSchema.parse(JSON.parse(liveRaw));
  } catch {
    console.error(c.red("the live credential is not a recognizable Claude OAuth blob."));
    return null;
  }

  let creds = blob.claudeAiOauth;
  if (isDeadCredential(creds)) {
    console.error(c.red("the live credential was cleared after a failed refresh."));
    console.error(`Run ${c.cyan("claude")} → ${c.cyan("/login")} first, then re-run ${c.cyan("tokenmaxxing init")}.`);
    return null;
  }
  if (isAccessTokenExpiring(creds)) {
    await withClaudeRefreshLock(async (lock) => {
      const raw2 = await readItem(liveTarget());
      if (raw2 == null) throw new Error("live credential vanished while waiting for the refresh lock");
      const current = CredentialBlobSchema.parse(JSON.parse(raw2)).claudeAiOauth;
      creds = isAccessTokenExpiring(current) ? await refreshCredential(current) : current;
      if (creds === current) return;
      if (lock.compromised()) throw new Error("refresh lock compromised mid-refresh - discarding the live rewrite");
      await writeItem(liveTarget(), mergeIntoLive(raw2, creds));
    });
  }
  const identity = await fetchTokenIdentity(creds.accessToken);
  if (identity.accountUuid !== oauthAccount.accountUuid) {
    console.error(c.red(`the live credential belongs to ${describeIdentity(identity)}, but ~/.claude.json identifies ${oauthAccount.emailAddress} - identity drift.`));
    console.error(`Run ${c.cyan("claude")} → ${c.cyan("/login")} to realign them, then re-run ${c.cyan("tokenmaxxing init")}.`);
    return null;
  }

  const id = oauthAccount.accountUuid;
  const parked = JSON.stringify({ claudeAiOauth: creds });
  return {
    id,
    email: oauthAccount.emailAddress,
    tier: claudeTierLabel(creds),
    oauthAccount,
    sample: null,
    park: () => writeItem(parkedTarget(credItemFor(id)), parked),
  };
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
  console.log(`${c.green("✓")} installed ${c.bold("claude")} supervisor + statusLine/Stop/SessionStart hooks`);
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
  waitsWhenDepleted: true,
  switchMargin: 1,
  switchNote: "",
  liveId: () => readOAuthAccount()?.accountUuid ?? null,
  liveOwner,
  presentIds: () => new Set(),
  gatedFamilies: (cfg) => gatedFamilies(loadUsage()?.model ?? null, cfg.policy.switchModels),
  observeLive,
  samplePool,
  mergeWindows,
  swap: performSwap,
  classifySwapError: (e) => (e instanceof InvalidGrantError ? "dead-grant" : isSkippableSwapError(e) ? "skip" : "fatal"),
  removeCredentials,
  login,
  importLive,
  preflight: () => pinBinOverride({ key: "claudeBin", bin: resolveVerifiedClaude() }),
  install,
  loginStep: (who) => `In the session that opens, run  ${c.bold("/login")}  with ${who}. It closes itself once you're in.`,
  windowLabel: (name) => name.toLowerCase(),
};
