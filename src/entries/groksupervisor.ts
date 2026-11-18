import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { omit } from "es-toolkit";
import type { Subprocess } from "bun";
import { GROK_BIN, UNMANAGED_ENV, WRAP_DEPTH_ENV, resolveRealBin, wrapDepth } from "../lib/claudebin.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { withLock } from "../lib/lock.ts";
import { errorMessage, log } from "../lib/log.ts";
import { endSession } from "../lib/telemetry.ts";
import { ensureGrokStoreHome, grok, grokSeatOpen, observeGrok, probeGrokSeats, rankGrokSeat } from "../lib/grok.ts";
import { GROK_HOME_ENV, grokPaths, grokPool, grokSeatFromEnv, inGrokStores } from "../lib/paths.ts";
import { thresholdBars, usableAt } from "../lib/picker.ts";
import { clearPresence } from "../lib/presence.ts";
import { childStdout, exitStatus, loopGuardTripped, raceMarkerOrExit, recordPresenceOrStop, relayStdout, runPassthrough, SEAT_POLL_MS, SEAT_RETRY_MS } from "../lib/supervise.ts";
import { saveTermios } from "../lib/tty.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { ErrnoSchema, type Account } from "../lib/types.ts";

const SUBCOMMANDS = new Set([
  "agent", "clone", "completions", "dashboard", "doctor", "du", "disk-usage", "export", "help", "inspect",
  "leader", "login", "logout", "mcp", "memory", "models", "plugin", "sessions", "setup", "trace", "update",
  "usage", "version", "v", "worker", "worktree", "wrap",
]);

const SEATED_SUBCMDS = new Set(["agent", "dashboard"]);

const PASSTHROUGH_FLAGS = new Set(["-h", "--help", "-v", "--version"]);

const VALUE_FLAGS = new Set([
  "--agent", "--agents", "--allow", "--deny", "--disallowed-tools", "--json-schema", "--leader-socket",
  "--model", "-m", "--max-turns", "--output-format", "--permission-mode", "--reasoning-effort", "--effort",
  "--rules", "--sandbox", "--system-prompt-override", "--tools", "--debug-file",
]);

const FIRST_LAUNCH_VALUE = new Set([
  "--add-dir", "--cwd", "--single", "-p", "--prompt-file", "--prompt-json", "--session-id", "-s", "--worktree-ref",
]);

const OPTIONAL_VALUE = new Set(["-r", "--resume", "-w", "--worktree"]);

const FIRST_LAUNCH_BOOL = new Set(["-c", "--continue", "--fork-session", "--oauth", "--restore-code"]);

type GrokArgs = {
  help: boolean;
  sub: string | null;
  single: boolean;
  sessionId: string | null;
  resumeId: string | null;
  resumeMostRecent: boolean;
  continueRecent: boolean;
  cwd: string | null;
  resumeFlags: string[];
};

function takeValue(argv: string[], i: number, a: string, flag: string, eq: number): { value: string | undefined; next: number } {
  if (eq > 0 && flag !== a) return { value: a.slice(eq + 1), next: i };
  return { value: argv[i + 1], next: i + 1 };
}

function analyzeGrokArgs(argv: string[]): GrokArgs {
  const out: GrokArgs = {
    help: false,
    sub: null,
    single: false,
    sessionId: null,
    resumeId: null,
    resumeMostRecent: false,
    continueRecent: false,
    cwd: null,
    resumeFlags: [],
  };
  let positionals = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (PASSTHROUGH_FLAGS.has(a)) {
      out.help = true;
      continue;
    }
    if (FIRST_LAUNCH_BOOL.has(a)) {
      if (a === "-c" || a === "--continue") out.continueRecent = true;
      continue;
    }
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (flag === "-r" || flag === "--resume") {
      const next = argv[i + 1];
      if (eq > 0 && flag !== a) out.resumeId = a.slice(eq + 1);
      else if (next != null && !next.startsWith("-")) {
        out.resumeId = next;
        i++;
      } else out.resumeMostRecent = true;
      continue;
    }
    if (OPTIONAL_VALUE.has(flag)) {
      if (eq < 0 && argv[i + 1] != null && !argv[i + 1]!.startsWith("-")) i++;
      continue;
    }
    if (flag === "-s" || flag === "--session-id") {
      const taken = takeValue(argv, i, a, flag, eq);
      out.sessionId = taken.value ?? null;
      i = taken.next;
      continue;
    }
    if (flag === "-p" || flag === "--single" || flag === "--prompt-file" || flag === "--prompt-json") {
      out.single = true;
      if (eq < 0) i++;
      continue;
    }
    if (flag === "--cwd") {
      const taken = takeValue(argv, i, a, flag, eq);
      out.cwd = taken.value ?? null;
      i = taken.next;
      continue;
    }
    if (FIRST_LAUNCH_VALUE.has(flag)) {
      if (eq < 0) i++;
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      const taken = takeValue(argv, i, a, flag, eq);
      out.resumeFlags.push(...(flag === a && taken.value !== undefined ? [a, taken.value] : [a]));
      i = taken.next;
      continue;
    }
    if (a.startsWith("-")) {
      out.resumeFlags.push(a);
      continue;
    }
    if (positionals++ === 0 && SUBCOMMANDS.has(a)) out.sub = a;
  }
  return out;
}

type LaunchMode = "passthrough" | "seat" | "managed";

function launchMode(args: GrokArgs): { mode: LaunchMode; why: string; inherited?: string } {
  if (args.help) return { mode: "passthrough", why: "help" };
  if (process.env.TOKENMAXXING_PROBE || process.env[UNMANAGED_ENV]) return { mode: "passthrough", why: "unmanaged" };
  if (process.env.XAI_API_KEY) return { mode: "passthrough", why: "XAI_API_KEY overrides the account login" };
  const inherited = grokSeatFromEnv(loadAccounts(grokPool).accounts.map((a) => a.id));
  if (inherited != null) return { mode: "seat", why: "inherits its parent's seat", inherited };
  if (args.sub != null) return SEATED_SUBCMDS.has(args.sub) ? { mode: "seat", why: args.sub } : { mode: "passthrough", why: args.sub };
  if (args.single) return { mode: "seat", why: "single-turn" };
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return { mode: "seat", why: "no terminal" };
  return { mode: "managed", why: "interactive" };
}

export function seatsGrokArgs(argv: string[]): boolean {
  const args = analyzeGrokArgs(argv);
  if (args.help) return false;
  if (args.sub != null) return SEATED_SUBCMDS.has(args.sub);
  return true;
}

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    const code = ErrnoSchema.safeParse(e).data?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
}

function newestSession(cwd: string): string | null {
  const dir = join(grokPaths.home, "sessions", encodeURIComponent(cwd));
  let best: { id: string; at: number } | null = null;
  for (const id of namesIn(dir)) {
    let at: number;
    try {
      at = statSync(join(dir, id, "summary.json")).mtimeMs;
    } catch (e) {
      const code = ErrnoSchema.safeParse(e).data?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw e;
    }
    if (best == null || at > best.at) best = { id, at };
  }
  return best?.id ?? null;
}

function sessionOf(args: GrokArgs, cwd: string): string | null {
  return args.sessionId ?? args.resumeId ?? (args.continueRecent || args.resumeMostRecent ? newestSession(cwd) : null);
}

type Watch = { decided: boolean; move: Account | null };

async function watchSeat(seatId: string): Promise<Watch> {
  try {
    const now = Date.now();
    const cfg = loadConfig();
    const account = loadAccounts(grokPool).accounts.find((a) => a.id === seatId);
    if (!account) return { decided: false, move: null };
    const observed = await observeGrok(account, cfg, now, { probe: true });
    const unmeasured = observed == null || now - observed.at > cfg.policy.usagePollTtlMs;
    if (unmeasured) log("groksupervisor.seat_unmeasured", { seat: account.id.slice(0, 8), usageAt: observed?.at });
    const rejected = loadAccounts(grokPool).accounts.find((a) => a.id === seatId)?.needsReauth === true;
    const current = observed ? { ...account, windows: observed.windows } : account;
    const until = usableAt({ ...current, hasCredits: false }, { now, thresholds: thresholdBars(cfg), currentId: account.id, families: null, seats: null });
    if (!rejected && until <= now) return { decided: unmeasured, move: null };
    await probeGrokSeats(now);
    const decision = await evaluateAndMaybeSwap(grok, now, true, null, { seatId: account.id });
    log("groksupervisor.seat_exhausted", { seat: account.id.slice(0, 8), until, reason: decision.reason, account: decision.account?.id.slice(0, 8) });
    return { decided: true, move: decision.swapped ? decision.account : null };
  } catch (e) {
    log("groksupervisor.seat_watch_error", { err: errorMessage(e) });
    return { decided: true, move: null };
  }
}

function validWanted(wanted: string | null, now: number): Account | null {
  if (wanted == null) return null;
  const a = loadAccounts(grokPool).accounts.find((x) => x.id === wanted);
  return a && grokSeatOpen(a, now) ? a : null;
}

const KILL_GRACE_MS = 30_000;

function unseatedEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const home = env.GROK_HOME;
  if (home == null || !inGrokStores(home)) return env;
  const rest = omit(env, ["GROK_HOME", GROK_HOME_ENV]);
  return env[GROK_HOME_ENV] != null ? { ...rest, GROK_HOME: env[GROK_HOME_ENV] } : rest;
}

function seatedEnv(env: Record<string, string | undefined>, accountId: string): Record<string, string | undefined> {
  return { ...env, GROK_HOME: ensureGrokStoreHome(accountId), [GROK_HOME_ENV]: grokPaths.home };
}

function warnUnseated(): void {
  if (loadAccounts(grokPool).accounts.length === 0) return;
  process.stderr.write("\x1b[33mtokenmaxxing: no pooled grok account is usable (run `tokenmaxxing doctor`) - this session runs on your own grok login\x1b[0m\n");
}

export async function runGrokSupervisor(argv: string[]): Promise<number> {
  if (loopGuardTripped("grok")) return 1;
  const real = resolveRealBin(GROK_BIN);
  const childEnv: Record<string, string | undefined> = { ...process.env, [WRAP_DEPTH_ENV]: String(wrapDepth() + 1) };
  const args = analyzeGrokArgs(argv);
  const { mode, why, inherited } = launchMode(args);

  if (mode !== "managed") {
    let child: Subprocess | null = null;
    process.on("SIGTERM", () => {
      if (child) child.kill("SIGTERM");
      else process.exit(143);
    });
    if (mode === "passthrough") {
      log("groksupervisor.passthrough", { why, seat: null });
      const env = grokSeatFromEnv(loadAccounts(grokPool).accounts.map((a) => a.id)) == null ? unseatedEnv(childEnv) : childEnv;
      return runPassthrough({ real, argv, env, onSpawn: (p) => { child = p; } });
    }
    const id = `seat-${process.pid}`;
    if (inherited == null) await probeGrokSeats(Date.now());
    const placed = await withLock(grokPool.lockFile, async () => {
      const seat = inherited != null ? (loadAccounts(grokPool).accounts.find((a) => a.id === inherited) ?? null) : rankGrokSeat(Date.now());
      log("groksupervisor.passthrough", { why, seat: seat?.id.slice(0, 8) ?? null });
      if (!seat) warnUnseated();
      const p = Bun.spawn([real, ...argv], {
        stdin: "inherit",
        stdout: childStdout(),
        stderr: "inherit",
        env: seat ? seatedEnv(childEnv, seat.id) : unseatedEnv(childEnv),
      });
      child = p;
      if (seat) {
        await recordPresenceOrStop({
          child: p,
          dir: grokPaths.presenceDir,
          id,
          accountId: seat.id,
          event: "groksupervisor.seat_presence_failed",
          message: "could not write the grok seat's presence file - refusing to run a session that placement cannot see",
          savedTermios: null,
        });
      }
      return p;
    });
    const drain = placed.stdout instanceof ReadableStream ? relayStdout(placed.stdout) : null;
    try {
      await placed.exited;
      await drain?.();
      return exitStatus(placed);
    } finally {
      clearPresence({ dir: grokPaths.presenceDir, id });
    }
  }

  const id = crypto.randomUUID();
  let child: Subprocess | null = null;
  let terminating = false;
  process.on("SIGTERM", () => {
    terminating = true;
    if (child) child.kill("SIGTERM");
    else process.exit(143);
  });
  const savedTermios = saveTermios();
  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});
  const say = (text: string) => {
    process.stderr.write(`\n\x1b[36m${text}\x1b[0m\n`);
  };

  const cwd = args.cwd ?? process.cwd();
  let session = sessionOf(args, cwd);
  let launchArgs = argv;
  if (session == null && !args.continueRecent && !args.resumeMostRecent && args.resumeId == null) {
    session = crypto.randomUUID();
    launchArgs = [...argv, "-s", session];
  }
  let respawns = 0;
  const startedAt = Date.now();
  let wanted: string | null = null;
  try {
    while (true) {
      await probeGrokSeats(Date.now());
      const launched = await withLock(grokPool.lockFile, async () => {
        clearPresence({ dir: grokPaths.presenceDir, id });
        if (terminating) return null;
        const picked = validWanted(wanted, Date.now()) ?? rankGrokSeat(Date.now());
        log("groksupervisor.launch", { id: id.slice(0, 8), respawns, seat: picked?.id.slice(0, 8) ?? null, session, args: launchArgs.join(" ") });
        if (!picked) warnUnseated();
        const spawned = Bun.spawn([real, ...launchArgs], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: picked ? seatedEnv(childEnv, picked.id) : unseatedEnv(childEnv),
        });
        child = spawned;
        if (picked) {
          await recordPresenceOrStop({
            child: spawned,
            dir: grokPaths.presenceDir,
            id,
            accountId: picked.id,
            event: "groksupervisor.presence_failed",
            message: "could not write the grok session's presence file - refusing to run a session that placement cannot see",
            savedTermios,
          });
        }
        return { proc: spawned, picked };
      });
      if (launched == null) return 143;
      const { proc, picked } = launched;

      const pending: { move: Account | null; killed: boolean } = { move: null, killed: false };
      let seatCheckAt = 0;
      let escalate: Timer | null = null;
      await raceMarkerOrExit({
        child: proc,
        tick: async () => {
          if (!picked || terminating || Date.now() < seatCheckAt) return false;
          const watched = await watchSeat(picked.id);
          seatCheckAt = Date.now() + (watched.decided ? SEAT_RETRY_MS : SEAT_POLL_MS);
          if (watched.move == null) return false;
          if (session == null) session = newestSession(cwd);
          if (session == null) {
            log("groksupervisor.session_unresolved", { id: id.slice(0, 8), pid: proc.pid, target: watched.move.id.slice(0, 8) });
            return false;
          }
          pending.move = watched.move;
          return true;
        },
        savedTermios,
        onKill: () => {
          pending.killed = true;
          escalate = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
        },
        onError: () => clearPresence({ dir: grokPaths.presenceDir, id }),
        onExited: () => {
          child = null;
          if (escalate) clearTimeout(escalate);
        },
      });

      if (pending.killed && !terminating && pending.move && session) {
        respawns++;
        log("groksupervisor.move", { id: id.slice(0, 8), from: picked?.id.slice(0, 8), to: pending.move.id.slice(0, 8), session });
        say(`↻ tokenmaxxing: moving grok to ${pending.move.label} - resuming the session. A turn that was running stopped; send it again to continue.`);
        wanted = pending.move.id;
        launchArgs = [...args.resumeFlags, "-r", session];
        continue;
      }
      clearPresence({ dir: grokPaths.presenceDir, id });
      log("groksupervisor.exit", { id: id.slice(0, 8), respawns, code: proc.exitCode, signal: proc.signalCode, terminated: terminating || undefined });
      return endSession({ tool: "grok", moves: respawns, outcome: "exit", startedAt, code: exitStatus(proc) });
    }
  } catch (e) {
    const msg = errorMessage(e);
    say(`tokenmaxxing: ${msg}`);
    log("groksupervisor.fatal", { err: msg });
    clearPresence({ dir: grokPaths.presenceDir, id });
    return endSession({ tool: "grok", moves: respawns, outcome: "fatal", startedAt, code: 1 });
  }
}
