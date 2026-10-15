import { readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { MUSE_BIN, UNMANAGED_ENV, WRAP_DEPTH_ENV, resolveRealBin, wrapDepth } from "../lib/claudebin.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { withLock } from "../lib/lock.ts";
import { errorMessage, log } from "../lib/log.ts";
import { ensureMuseStoreHome, muse, museSeatOpen, observeMuse, probeMuseSeats, rankMuseSeat } from "../lib/muse.ts";
import { musePaths, musePool, museSeatFromEnv } from "../lib/paths.ts";
import { thresholdBars, usableAt } from "../lib/picker.ts";
import { clearPresence } from "../lib/presence.ts";
import { childStdout, exitStatus, loopGuardTripped, raceMarkerOrExit, recordPresenceOrStop, relayStdout, runPassthrough, SEAT_POLL_MS, SEAT_RETRY_MS } from "../lib/supervise.ts";
import { saveTermios } from "../lib/tty.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { ErrnoSchema, type Account } from "../lib/types.ts";

const SUBCOMMANDS = new Set([
  "resume", "exec", "config", "export", "trace", "model-profile", "skills", "voice", "plugins", "sandbox",
  "schema", "serve", "session-message", "mcp", "auth", "login", "logout", "init", "help",
]);

// Headless runs take a seat for their whole life: nothing can resume them elsewhere.
const SEATED_SUBCMDS = new Set(["exec", "serve"]);

const PASSTHROUGH_FLAGS = new Set(["-h", "--help", "-V", "--version"]);

const VALUE_FLAGS = new Set([
  "--agents", "--provider", "--preset", "--model", "--contributor-mode", "-c", "--config", "--reasoning-effort",
  "--effort", "--base-url", "--image", "--workspace", "--worktree-base", "--worktree-existing", "--approval-mode",
  "--permission-profile", "--approval-judge", "--echo-delay-ms", "--sandbox-network",
]);

const WORKTREE_MODES = new Set(["off", "create", "existing"]);

// Flags that belong to the first launch only: a resumed session keeps its worktree and has had its image.
const FIRST_LAUNCH_FLAGS = new Set(["--image", "-w", "--worktree", "--worktree-base", "--worktree-existing"]);

type MuseArgs = { help: boolean; sub: string | null; provider: string | null; sessionLog: boolean; resumeFlags: string[] };

export function analyzeMuseArgs(argv: string[]): MuseArgs {
  const out: MuseArgs = { help: false, sub: null, provider: null, sessionLog: true, resumeFlags: [] };
  let positionals = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (PASSTHROUGH_FLAGS.has(a)) out.help = true;
    if (a === "--no-session-log") out.sessionLog = false;
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (flag === "-w" || flag === "--worktree") {
      if (eq < 0 && WORKTREE_MODES.has(argv[i + 1] ?? "")) i++;
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      const value = eq > 0 && flag !== a ? a.slice(eq + 1) : argv[++i];
      if (flag === "--provider") out.provider = value ?? null;
      if (!FIRST_LAUNCH_FLAGS.has(flag)) out.resumeFlags.push(...(flag === a && value !== undefined ? [a, value] : [a]));
      continue;
    }
    if (a.startsWith("-")) {
      if (a !== "--last" && !FIRST_LAUNCH_FLAGS.has(flag)) out.resumeFlags.push(a);
      continue;
    }
    if (positionals++ === 0 && SUBCOMMANDS.has(a)) out.sub = a;
  }
  return out;
}

type LaunchMode = "passthrough" | "seat" | "managed";

function launchMode(args: MuseArgs): { mode: LaunchMode; why: string } {
  if (args.help) return { mode: "passthrough", why: "help" };
  if (process.env.TOKENMAXXING_PROBE || process.env[UNMANAGED_ENV]) return { mode: "passthrough", why: "unmanaged" };
  if (args.provider != null && args.provider !== "meta") return { mode: "passthrough", why: `provider ${args.provider}` };
  if (process.env.META_API_KEY) return { mode: "passthrough", why: "META_API_KEY overrides the account login" };
  if (museSeatFromEnv(loadAccounts(musePool).accounts.map((a) => a.id)) != null) return { mode: "passthrough", why: "inherits its parent's seat" };
  if (args.sub != null && args.sub !== "resume") return SEATED_SUBCMDS.has(args.sub) ? { mode: "seat", why: args.sub } : { mode: "passthrough", why: args.sub };
  if (!args.sessionLog) return { mode: "seat", why: "no session log to resume" };
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return { mode: "seat", why: "no terminal" };
  return { mode: "managed", why: "interactive" };
}

const LockSchema = { pid: /^pid=(\d+)$/m, host: /^host=(.*)$/m };

function namesDescending(dir: string): string[] {
  try {
    return readdirSync(dir).sort().reverse();
  } catch (e) {
    const code = ErrnoSchema.safeParse(e).data?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
}

// Muse Code keeps each session in sessions/<yyyy>/<mm>/<dd>/<session id>/ and writes the pid of the process that
// holds it open to .session.lock, a resume included. The newest sessions come first.
function sessionHeldBy(pid: number): string | null {
  const host = hostname();
  for (const year of namesDescending(musePaths.sessionsDir)) {
    for (const month of namesDescending(join(musePaths.sessionsDir, year))) {
      for (const day of namesDescending(join(musePaths.sessionsDir, year, month))) {
        const dayDir = join(musePaths.sessionsDir, year, month, day);
        for (const id of namesDescending(dayDir)) {
          let lock: string;
          try {
            lock = readFileSync(join(dayDir, id, ".session.lock"), "utf8");
          } catch (e) {
            const code = ErrnoSchema.safeParse(e).data?.code;
            if (code === "ENOENT" || code === "ENOTDIR") continue;
            throw e;
          }
          const lockHost = LockSchema.host.exec(lock)?.[1];
          if (Number(LockSchema.pid.exec(lock)?.[1]) === pid && (lockHost == null || lockHost === host)) return id;
        }
      }
    }
  }
  return null;
}

type Watch = { decided: boolean; move: Account | null };

async function watchSeat(seatId: string): Promise<Watch> {
  try {
    const now = Date.now();
    const cfg = loadConfig();
    const account = loadAccounts(musePool).accounts.find((a) => a.id === seatId);
    if (!account) return { decided: false, move: null };
    const observed = await observeMuse(account, cfg, now, { probe: true });
    const unmeasured = observed == null || now - observed.at > cfg.policy.usagePollTtlMs;
    if (unmeasured) log("musesupervisor.seat_unmeasured", { seat: account.id.slice(0, 8), usageAt: observed?.at });
    const rejected = loadAccounts(musePool).accounts.find((a) => a.id === seatId)?.needsReauth === true;
    const current = observed ? { ...account, windows: observed.windows } : account;
    const until = usableAt({ ...current, hasCredits: false }, { now, thresholds: thresholdBars(cfg), currentId: account.id, families: null, seats: null });
    if (!rejected && until <= now) return { decided: unmeasured, move: null };
    // The move decision folds the other accounts from storage, so a destination is read fresh first.
    await probeMuseSeats(now);
    const decision = await evaluateAndMaybeSwap(muse, now, true, null, { seatId: account.id });
    log("musesupervisor.seat_exhausted", { seat: account.id.slice(0, 8), until, reason: decision.reason, account: decision.account?.id.slice(0, 8) });
    return { decided: true, move: decision.swapped ? decision.account : null };
  } catch (e) {
    log("musesupervisor.seat_watch_error", { err: errorMessage(e) });
    return { decided: true, move: null };
  }
}

function validWanted(wanted: string | null, now: number): Account | null {
  if (wanted == null) return null;
  const a = loadAccounts(musePool).accounts.find((x) => x.id === wanted);
  return a && museSeatOpen(a, now) ? a : null;
}

const KILL_GRACE_MS = 30_000;

function warnUnseated(): void {
  if (loadAccounts(musePool).accounts.length === 0) return;
  process.stderr.write("\x1b[33mtokenmaxxing: no pooled Muse Code account is usable (run `tokenmaxxing doctor`) - this session runs on your own Muse Code login\x1b[0m\n");
}

export async function runMuseSupervisor(argv: string[]): Promise<number> {
  if (loopGuardTripped("muse")) return 1;
  const real = resolveRealBin(MUSE_BIN);
  const childEnv: Record<string, string | undefined> = { ...process.env, [WRAP_DEPTH_ENV]: String(wrapDepth() + 1) };
  const args = analyzeMuseArgs(argv);
  const { mode, why } = launchMode(args);

  if (mode !== "managed") {
    let child: Subprocess | null = null;
    process.on("SIGTERM", () => {
      if (child) child.kill("SIGTERM");
      else process.exit(143);
    });
    if (mode === "passthrough") {
      log("musesupervisor.passthrough", { why, seat: null });
      return runPassthrough({ real, argv, env: childEnv, onSpawn: (p) => { child = p; } });
    }
    const id = `seat-${process.pid}`;
    await probeMuseSeats(Date.now());
    // Placement, spawn, and presence share one lock hold, so `rm` never removes an account a launch is taking.
    const placed = await withLock(musePool.lockFile, async () => {
      const seat = rankMuseSeat(Date.now());
      log("musesupervisor.passthrough", { why, seat: seat?.id.slice(0, 8) ?? null });
      if (!seat) warnUnseated();
      const p = Bun.spawn([real, ...argv], {
        stdin: "inherit",
        stdout: childStdout(),
        stderr: "inherit",
        env: seat ? { ...childEnv, XDG_CONFIG_HOME: ensureMuseStoreHome(seat.id) } : childEnv,
      });
      child = p;
      if (seat) {
        await recordPresenceOrStop({
          child: p,
          dir: musePaths.presenceDir,
          id,
          accountId: seat.id,
          event: "musesupervisor.seat_presence_failed",
          message: "could not write the muse seat's presence file - refusing to run a session that placement cannot see",
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
      clearPresence({ dir: musePaths.presenceDir, id });
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

  let launchArgs = argv;
  let respawns = 0;
  let wanted: string | null = null;
  try {
    while (true) {
      await probeMuseSeats(Date.now());
      const launched = await withLock(musePool.lockFile, async () => {
        clearPresence({ dir: musePaths.presenceDir, id });
        if (terminating) return null;
        const picked = validWanted(wanted, Date.now()) ?? rankMuseSeat(Date.now());
        log("musesupervisor.launch", { id: id.slice(0, 8), respawns, seat: picked?.id.slice(0, 8) ?? null, args: launchArgs.join(" ") });
        if (!picked) warnUnseated();
        const spawned = Bun.spawn([real, ...launchArgs], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: { ...childEnv, ...(picked ? { XDG_CONFIG_HOME: ensureMuseStoreHome(picked.id) } : {}) },
        });
        child = spawned;
        if (picked) {
          await recordPresenceOrStop({
            child: spawned,
            dir: musePaths.presenceDir,
            id,
            accountId: picked.id,
            event: "musesupervisor.presence_failed",
            message: "could not write the muse session's presence file - refusing to run a session that placement cannot see",
            savedTermios,
          });
        }
        return { proc: spawned, picked };
      });
      if (launched == null) return 143;
      const { proc, picked } = launched;

      const pending: { move: Account | null; session: string | null; killed: boolean } = { move: null, session: null, killed: false };
      let seatCheckAt = 0;
      let escalate: Timer | null = null;
      await raceMarkerOrExit({
        child: proc,
        tick: async () => {
          if (!picked || terminating || Date.now() < seatCheckAt) return false;
          const watched = await watchSeat(picked.id);
          seatCheckAt = Date.now() + (watched.decided ? SEAT_RETRY_MS : SEAT_POLL_MS);
          if (watched.move == null) return false;
          const session = sessionHeldBy(proc.pid);
          if (session == null) {
            log("musesupervisor.session_unresolved", { id: id.slice(0, 8), pid: proc.pid, target: watched.move.id.slice(0, 8) });
            return false;
          }
          pending.move = watched.move;
          pending.session = session;
          return true;
        },
        savedTermios,
        onKill: () => {
          pending.killed = true;
          escalate = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
        },
        onError: () => clearPresence({ dir: musePaths.presenceDir, id }),
        onExited: () => {
          child = null;
          if (escalate) clearTimeout(escalate);
        },
      });

      if (pending.killed && !terminating && pending.move && pending.session) {
        respawns++;
        log("musesupervisor.move", { id: id.slice(0, 8), from: picked?.id.slice(0, 8), to: pending.move.id.slice(0, 8), session: pending.session });
        say(`↻ tokenmaxxing: moving Muse Code to ${pending.move.label} - resuming the session. A turn that was running stopped; send it again to continue.`);
        wanted = pending.move.id;
        launchArgs = [...args.resumeFlags, "resume", pending.session];
        continue;
      }
      clearPresence({ dir: musePaths.presenceDir, id });
      log("musesupervisor.exit", { id: id.slice(0, 8), respawns, code: proc.exitCode, signal: proc.signalCode, terminated: terminating || undefined });
      return exitStatus(proc);
    }
  } catch (e) {
    const msg = errorMessage(e);
    say(msg.startsWith("tokenmaxxing:") ? msg : `tokenmaxxing: ${msg}`);
    log("musesupervisor.fatal", { err: msg });
    clearPresence({ dir: musePaths.presenceDir, id });
    return 1;
  }
}
