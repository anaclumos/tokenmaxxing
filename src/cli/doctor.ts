import { existsSync, readFileSync, realpathSync } from "node:fs";
import { analyzeArgs } from "../entries/supervisor.ts";
import { seatsCodexArgs } from "../entries/codexsupervisor.ts";
import { CLAUDE_BIN, CODEX_BIN, MUSE_BIN, PI_BIN, verifyRealBin } from "../lib/claudebin.ts";
import { checkSettings, installedBin } from "../lib/settings.ts";
import { activationHint, CHECK_JOB, codexStoreHookTrust, codexSupervisorLink, findClaudeShadowers, HUB_JOB, isBinDirAhead, jobHealthy, museSupervisorLink, piSupervisorLink, shellRcPath } from "../lib/install.ts";
import { museStoreIdentity } from "../lib/muse.ts";
import { readPiStore } from "../lib/piauth.ts";
import { errorMessage } from "../lib/log.ts";
import { claudePool, codexPool, musePool, paths } from "../lib/paths.ts";
import { executablePath, processTable } from "../lib/proc.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { readStore } from "../lib/credstore.ts";
import { codexIdentityOf, codexSeatIdOf, readCodexStoreAuth } from "../lib/codexauth.ts";
import { isAccessTokenExpiring, isDeadCredential, fetchTokenIdentity, describeIdentity } from "../lib/oauth.ts";
import { c } from "./render.ts";

type RealBin = { name: string; real: string; link: string; seated: (argv: string[]) => boolean };

const NON_SESSION_CLAUDE_FLAGS = new Set(["--chrome-native-host"]);

function realOrNull(path: string | null): string | null {
  if (path == null) return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

const SUPERVISE_VERB = /\s__supervise(-[a-z]+)?(\s|$)/;

function unsupervisedRuns(bins: RealBin[]): { bin: RealBin; pid: number; parent: string }[] {
  if (bins.length === 0) return [];
  const table = processTable();
  const entry = realpathSync(Bun.main);
  const binOf = new Map<number, RealBin>();
  for (const pid of table.keys()) {
    const exe = realOrNull(executablePath(pid));
    const bin = bins.find((b) => b.real === exe);
    if (bin) binOf.set(pid, bin);
  }
  const out: { bin: RealBin; pid: number; parent: string }[] = [];
  for (const [pid, bin] of binOf) {
    const row = table.get(pid)!;
    if (!bin.seated(row.args.split(" ").slice(1).filter(Boolean))) continue;
    let owned = false;
    for (let cur = row.ppid, hops = 0; cur > 1 && hops < 64 && !owned; hops++) {
      const up = table.get(cur);
      if (!up) break;
      owned = binOf.has(cur) || up.args.includes(entry) || SUPERVISE_VERB.test(up.args);
      cur = up.ppid;
    }
    if (!owned) out.push({ bin, pid, parent: table.get(row.ppid)?.name || `pid ${row.ppid}` });
  }
  return out;
}

export async function cmdDoctor(): Promise<number> {
  let failed = 0;
  const check = (cond: boolean, label: string, hint?: string) => {
    if (!cond) failed++;
    console.log(`${cond ? c.green("✓") : c.red("✗")} ${label}${!cond && hint ? c.dim(`  - ${hint}`) : ""}`);
  };
  const note = (text: string) => console.log(c.dim(`  - ${text}`));
  const warn = (text: string) => console.log(c.yellow(`⚠ ${text}`));

  check(existsSync(paths.supervisorLink), "claude supervisor wrapper present", "run `tokenmaxxing init`");
  check(existsSync(installedBin()), "tokenmaxxing binary installed", "run `tokenmaxxing init`");
  check(isBinDirAhead(), `${paths.binDir} is ahead of the real claude on PATH`, `export PATH="${paths.binDir}:$PATH"`);

  const s = checkSettings();
  check(s.statusLineOk, "statusLine shim installed in settings.json", "run `tokenmaxxing init`");
  check(s.subagentStatusLineOk, "subagentStatusLine shim installed in settings.json", "run `tokenmaxxing init`");
  check(s.stopOk, "Stop hook installed in settings.json", "run `tokenmaxxing init`");
  check(s.stopFailureOk, "StopFailure hook installed in settings.json", "run `tokenmaxxing init`");
  check(s.sessionStartOk, "SessionStart hook installed in settings.json", "run `tokenmaxxing init`");
  check(jobHealthy(CHECK_JOB), "periodic check timer active", activationHint(CHECK_JOB));
  if (existsSync(paths.supervisorLink)) {
    if (HUB_JOB.skip()) note("usage hub service is owned outside init (TOKENMAXXING_SKIP_HUB set) - not verified here");
    else check(jobHealthy(HUB_JOB), "usage hub service active", "run `tokenmaxxing init` (it writes the unit and activates it)");
  }

  const idx = loadAccounts(claudePool);
  check(idx.accounts.length > 0, "at least one account in the pool", "run `tokenmaxxing init`");

  for (const a of idx.accounts) {
    let creds;
    try {
      creds = await readStore(a.id);
    } catch (e) {
      check(false, `store credential readable for ${a.label}`, errorMessage(e).slice(0, 100));
      continue;
    }
    check(creds != null, `store credential present for ${a.label}`, `run \`tokenmaxxing auth ${a.label}\``);
    if (creds) {
      if (isDeadCredential(creds)) check(false, `${a.label}'s store credential is usable`, `cleared after a failed refresh - run \`tokenmaxxing auth ${a.label}\``);
      else if (isAccessTokenExpiring(creds)) note(`${a.label} identity unverifiable (access token expired)`);
      else {
        try {
          const identity = await fetchTokenIdentity(creds.accessToken);
          check(identity.accountUuid === a.id, `store credential identity matches ${a.label}`, `token belongs to ${describeIdentity(identity)} - run \`tokenmaxxing auth ${a.label}\``);
        } catch (e) {
          check(false, `store credential identity matches ${a.label}`, errorMessage(e).slice(0, 100));
        }
      }
    }
    if (a.needsReauth) check(false, `${a.label} needs re-auth`, `run \`tokenmaxxing auth ${a.label}\` to re-login`);
  }

  const cfg = loadConfig();
  const cidx = loadAccounts(codexPool);
  const codexShim = existsSync(codexSupervisorLink());
  if (cidx.accounts.length === 0) {
    note("no codex accounts in the pool (run `tokenmaxxing init --codex` to pool codex too)");
  } else if (codexShim) {
    check(!!cfg.codexBin && existsSync(cfg.codexBin), "real codex binary resolved", "run `tokenmaxxing init --codex`");
    if (cfg.codexBin && existsSync(cfg.codexBin)) {
      const fail = verifyRealBin({ ...CODEX_BIN, bin: cfg.codexBin });
      check(fail === null, "codexBin launches the real codex", fail ?? undefined);
      check(isBinDirAhead(CODEX_BIN), `${paths.binDir} is ahead of the real codex on PATH`, `export PATH="${paths.binDir}:$PATH"`);
    }
  } else {
    warn("codex accounts are pooled but the codex supervisor is not installed - run `tokenmaxxing init --codex`");
  }
  for (const a of cidx.accounts) {
    let auth = null;
    let authErr: string | null = null;
    try {
      auth = readCodexStoreAuth(a.id);
    } catch (e) {
      authErr = errorMessage(e).slice(0, 100);
    }
    check(auth != null, `codex store credential present for ${a.label}`, authErr ?? `run \`tokenmaxxing auth --codex ${a.label}\``);
    if (auth) {
      let match = false;
      let matchHint = `run \`tokenmaxxing auth --codex ${a.label}\``;
      try {
        match = codexIdentityOf({ auth }).id === a.id;
        if (!match) matchHint = `store credential belongs to another account - ${matchHint}`;
      } catch (e) {
        matchHint = errorMessage(e).slice(0, 100);
      }
      check(match, `codex store credential identity matches ${a.label}`, matchHint);
    }
    if (a.needsReauth) check(false, `${a.label} (codex) needs re-auth`, `run \`tokenmaxxing auth --codex ${a.label}\` to re-login`);
    if (!codexShim) continue;
    const trust = codexStoreHookTrust(a.id);
    if (trust === "untrusted") warn(`${a.label} (codex): Stop hook not trusted for this seat - open a supervised codex session on it, run /hooks, and trust it, or auto-switching stays inert there`);
    else if (trust === "unknown") note(`${a.label} (codex): hook trust unknown (no hooks.json or config.toml yet - launch a supervised session once, then trust via /hooks)`);
  }

  check(!!cfg.claudeBin && existsSync(cfg.claudeBin), "real claude binary resolved", "set claudeBin in config.json");
  if (cfg.claudeBin && existsSync(cfg.claudeBin)) {
    const fail = verifyRealBin({ ...CLAUDE_BIN, bin: cfg.claudeBin });
    check(fail === null, "claudeBin launches the real claude", fail ?? undefined);
  }

  if (existsSync(piSupervisorLink())) {
    check(!!cfg.piBin && existsSync(cfg.piBin), "real pi binary resolved", "run `tokenmaxxing init --pi`");
    if (cfg.piBin && existsSync(cfg.piBin)) {
      const fail = verifyRealBin({ ...PI_BIN, bin: cfg.piBin });
      check(fail === null, "piBin launches the real pi", fail ?? undefined);
      check(isBinDirAhead(PI_BIN), `${paths.binDir} is ahead of the real pi on PATH`, `export PATH="${paths.binDir}:$PATH"`);
    }
    for (const [pool, poolPaths, flag] of [["claude", claudePool, ""], ["codex", codexPool, " --codex"]] as const) {
      for (const a of loadAccounts(poolPaths).accounts) {
        let cred;
        try {
          cred = readPiStore(pool, a.id);
        } catch (e) {
          check(false, `pi login readable for ${a.label}`, errorMessage(e).slice(0, 100));
          continue;
        }
        if (!cred) {
          note(`${a.label} (${pool}) has no pi login - pi sessions skip it (run \`tokenmaxxing auth --pi${flag} ${a.label}\`)`);
          continue;
        }
        if (pool === "codex") {
          check(codexSeatIdOf({ jwt: cred.access }) === a.id, `pi login identity matches ${a.label} (codex)`, `run \`tokenmaxxing auth --pi --codex ${a.label}\``);
          continue;
        }
        if (cred.expires <= Date.now()) {
          note(`${a.label} pi login identity unverifiable (access token expired; pi refreshes it in its next session)`);
          continue;
        }
        try {
          const identity = await fetchTokenIdentity(cred.access);
          check(identity.accountUuid === a.id, `pi login identity matches ${a.label}`, `token belongs to ${describeIdentity(identity)} - run \`tokenmaxxing auth --pi ${a.label}\``);
        } catch (e) {
          check(false, `pi login identity matches ${a.label}`, errorMessage(e).slice(0, 100));
        }
      }
    }
  }

  const midx = loadAccounts(musePool);
  if (existsSync(museSupervisorLink())) {
    check(!!cfg.museBin && existsSync(cfg.museBin), "real muse binary resolved", "run `tokenmaxxing init --muse`");
    if (cfg.museBin && existsSync(cfg.museBin)) {
      const fail = verifyRealBin({ ...MUSE_BIN, bin: cfg.museBin });
      check(fail === null, "museBin launches the real muse", fail ?? undefined);
      check(isBinDirAhead(MUSE_BIN), `${paths.binDir} is ahead of the real muse on PATH`, `export PATH="${paths.binDir}:$PATH"`);
    }
  } else if (midx.accounts.length > 0) {
    warn("Muse Code accounts are pooled but the muse supervisor is not installed - run `tokenmaxxing init --muse`");
  }
  for (const a of midx.accounts) {
    let ids: string[] = [];
    let readErr: string | null = null;
    try {
      ids = museStoreIdentity(a.id);
    } catch (e) {
      readErr = errorMessage(e).slice(0, 100);
    }
    check(ids.length > 0, `Muse Code store login present for ${a.label}`, readErr ?? `run \`tokenmaxxing auth --muse ${a.label}\``);
    if (ids.length > 0) check(ids.includes(a.id), `Muse Code store login identity matches ${a.label}`, `the store holds another account's login - run \`tokenmaxxing auth --muse ${a.label}\``);
    if (a.needsReauth) check(false, `${a.label} (muse) needs re-auth`, `run \`tokenmaxxing auth --muse ${a.label}\` to re-login`);
  }

  const rc = shellRcPath();
  if (rc && existsSync(rc)) {
    for (const s of findClaudeShadowers(readFileSync(rc, "utf8"))) {
      if (s.kind === "shadow") warn(`${rc}: ${s.line.startsWith("alias ") ? "alias" : "function"} \`claude\` shadows the supervised claude wrapper - launches through it skip tokenmaxxing`);
      else warn(`${rc}: alias \`${s.name}\` hardcodes a claude path and bypasses the supervisor - use plain \`claude\` in its body instead`);
    }
  }

  const bins: RealBin[] = [];
  const realClaude = existsSync(paths.supervisorLink) ? realOrNull(cfg.claudeBin || null) : null;
  if (realClaude) bins.push({ name: "claude", real: realClaude, link: paths.supervisorLink, seated: (argv) => analyzeArgs(argv).manage && !argv.some((a) => NON_SESSION_CLAUDE_FLAGS.has(a)) });
  const realCodex = codexShim ? realOrNull(cfg.codexBin || null) : null;
  if (realCodex) bins.push({ name: "codex", real: realCodex, link: codexSupervisorLink(), seated: seatsCodexArgs });
  try {
    for (const run of unsupervisedRuns(bins)) {
      warn(`${run.parent} runs ${run.bin.name} outside the supervisor (pid ${run.pid}) - quit and reopen it if it was open before init added the PATH line, or set its ${run.bin.name} path to ${run.bin.link}`);
    }
  } catch (e) {
    note(`could not list running processes: ${errorMessage(e).slice(0, 100)}`);
  }

  console.log();
  console.log(failed === 0 ? c.green("all good ✓") : c.yellow("issues found - see above"));
  return failed === 0 ? 0 : 1;
}
