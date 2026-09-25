import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { sortBy, uniq } from "es-toolkit";
import { z } from "zod";
import { PI_BIN, UNMANAGED_ENV, WRAP_DEPTH_ENV, resolveRealBin, wrapDepth } from "../lib/claudebin.ts";
import { observeCodex } from "../lib/codex.ts";
import { evaluateAndMaybeSwap, type SwapDecision } from "../lib/decide.ts";
import { withLock } from "../lib/lock.ts";
import { errorMessage, log } from "../lib/log.ts";
import { claudePool, codexPaths, expandTilde, optionalEnv, paths, piPaths, type PiPool } from "../lib/paths.ts";
import { pickPiSeat, piMovers } from "../lib/pi.ts";
import { ensurePiStoreHome, piStoreUsable } from "../lib/piauth.ts";
import { thresholdBars, usableAt } from "../lib/picker.ts";
import { clearPresence, livingPresences } from "../lib/presence.ts";
import { teeObservation } from "../lib/sample.ts";
import { countdownWait, exitStatus, loopGuardTripped, raceMarkerOrExit, recordPresenceOrStop, runPassthrough, SEAT_POLL_MS, SEAT_RETRY_MS } from "../lib/supervise.ts";
import { saveTermios } from "../lib/tty.ts";
import { loadAccounts, loadConfig, releaseWaitClaim } from "../lib/state.ts";
import { gatedFamilies, modelFromFlag } from "../lib/usage.ts";
import { ErrnoSchema, JsonTextSchema, type Account, type ModelInfo } from "../lib/types.ts";

const SUBCOMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth"]);

const UNMANAGED_FLAGS = new Set(["-h", "--help", "-v", "--version", "-p", "--print", "-r", "--resume", "--no-session", "--api-key", "--export", "--list-models"]);

const VALUE_FLAGS = new Set([
  "--provider", "--model", "--system-prompt", "--append-system-prompt", "-n", "--name", "--session-dir",
  "--models", "-t", "--tools", "-xt", "--exclude-tools", "--thinking", "-e", "--extension", "--skill",
  "--prompt-template", "--theme", "--use-theme", "--mode", "--tui-mode",
]);

const BOOLEAN_FLAGS = new Set([
  "-nt", "--no-tools", "-nbt", "--no-builtin-tools", "-ne", "--no-extensions", "-ns", "--no-skills",
  "-np", "--no-prompt-templates", "--no-themes", "-nc", "--no-context-files", "--verbose",
  "-a", "--approve", "-na", "--no-approve", "--offline",
]);

type PiArgs = {
  provider: string | null;
  model: string | null;
  sessionDir: string | null;
  sessionId: string | null;
  session: string | null;
  fork: boolean;
  continueLatest: boolean;
  approve: boolean | null;
  rest: string[];
  flags: string[];
};

export function analyzePiArgs(argv: string[]): PiArgs | null {
  if (argv[0] !== undefined && SUBCOMMANDS.has(argv[0])) return null;
  const out: PiArgs = { provider: null, model: null, sessionDir: null, sessionId: null, session: null, fork: false, continueLatest: false, approve: null, rest: [], flags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      out.rest.push(...argv.slice(i));
      break;
    }
    if (UNMANAGED_FLAGS.has(a)) return null;
    if (a === "-c" || a === "--continue") {
      out.continueLatest = true;
      continue;
    }
    if (a === "--session-id" || a === "--session") {
      const value = argv[++i];
      if (value === undefined) return null;
      if (a === "--session-id") out.sessionId = value;
      else out.session = value;
      continue;
    }
    out.rest.push(a);
    if (a === "--fork") {
      const value = argv[++i];
      if (value === undefined) return null;
      out.rest.push(value);
      out.fork = true;
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const value = argv[i + 1];
      if (value === undefined) return null;
      i++;
      out.rest.push(value);
      out.flags.push(a, value);
      if (a === "--mode" && value !== "text") return null;
      if (a === "--provider") out.provider = value;
      else if (a === "--model") out.model = value;
      else if (a === "--session-dir") out.sessionDir = value;
      continue;
    }
    if (BOOLEAN_FLAGS.has(a)) {
      out.flags.push(a);
      if (a === "-a" || a === "--approve") out.approve = true;
      else if (a === "-na" || a === "--no-approve") out.approve = false;
      continue;
    }
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (!a.includes("=") && next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
        i++;
        out.rest.push(next);
        out.flags.push(a, next);
      } else out.flags.push(a);
      continue;
    }
    if (a.startsWith("-")) return null;
  }
  const selectors = [out.session != null, out.continueLatest, out.sessionId != null || out.fork].filter(Boolean).length;
  return selectors > 1 ? null : out;
}

const PiSettingsSchema = z.looseObject({
  defaultProvider: z.string().optional().catch(undefined),
  sessionDir: z.string().optional().catch(undefined),
  defaultProjectTrust: z.string().optional().catch(undefined),
});
type PiSettings = z.infer<typeof PiSettingsSchema>;
type PiSettingsScopes = { global: PiSettings; project: PiSettings; projectTrusted: boolean };

const PiTrustSchema = z.record(z.string(), z.unknown());

function readPiJson<T extends z.ZodType>(file: string, schema: T): z.output<T> | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return null;
    throw e;
  }
  const parsed = schema.safeParse(JsonTextSchema.safeParse(text.startsWith("﻿") ? text.slice(1) : text).data);
  if (!parsed.success) log("pisupervisor.pi_file_unreadable", { file });
  return parsed.success ? parsed.data : null;
}

function projectTrusted(args: PiArgs, global: PiSettings): boolean {
  if (args.approve != null) return args.approve;
  const trust = readPiJson(join(piPaths.home, "trust.json"), PiTrustSchema) ?? {};
  let dir = realpathSync(process.cwd());
  while (true) {
    const decision = trust[dir];
    if (decision === true || decision === false) return decision;
    const parent = dirname(dir);
    if (parent === dir) return global.defaultProjectTrust === "always";
    dir = parent;
  }
}

function piSettings(args: PiArgs): PiSettingsScopes {
  const global = readPiJson(join(piPaths.home, "settings.json"), PiSettingsSchema) ?? {};
  return {
    global,
    project: readPiJson(join(process.cwd(), ".pi", "settings.json"), PiSettingsSchema) ?? {},
    projectTrusted: projectTrusted(args, global),
  };
}

function poolOf(args: PiArgs, settings: PiSettingsScopes): PiPool | null {
  const slash = args.model?.indexOf("/") ?? -1;
  const defaultProvider = (settings.projectTrusted ? settings.project.defaultProvider : undefined) ?? settings.global.defaultProvider;
  const modelProvider = args.model == null ? defaultProvider : slash > 0 ? args.model.slice(0, slash) : undefined;
  const provider = (args.provider ?? modelProvider)?.toLowerCase();
  return provider === "anthropic" ? "claude" : provider === "openai-codex" ? "codex" : null;
}

function sessionModel(args: PiArgs): ModelInfo | null {
  const id = args.model?.split(":")[0] ?? null;
  return modelFromFlag(id == null ? null : id.slice(id.indexOf("/") + 1));
}

function sessionDirs(args: PiArgs, settings: PiSettingsScopes): string[] {
  const custom = [args.sessionDir, optionalEnv("PI_CODING_AGENT_SESSION_DIR"), settings.project.sessionDir, settings.global.sessionDir]
    .filter((d): d is string => d != null && d !== "")
    .map((d) => resolve(expandTilde(d)));
  const cwd = process.cwd();
  const trimmed = cwd.startsWith("/") || cwd.startsWith("\\") ? cwd.slice(1) : cwd;
  return uniq([...custom, join(piPaths.home, "sessions", `--${trimmed.replaceAll("/", "-").replaceAll("\\", "-").replaceAll(":", "-")}--`)]);
}

const SessionHeaderSchema = z.looseObject({ type: z.literal("session"), id: z.string(), cwd: z.string() });

function sessionHeader(path: string): z.infer<typeof SessionHeaderSchema> | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(16 * 1024);
    const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
    const end = text.indexOf("\n");
    return SessionHeaderSchema.safeParse(JsonTextSchema.safeParse(end === -1 ? text : text.slice(0, end)).data).data ?? null;
  } finally {
    closeSync(fd);
  }
}

function sessionFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

function localSessions(dir: string): string[] {
  const cwd = resolve(process.cwd());
  const dated = sessionFiles(dir).flatMap((f) => {
    try {
      return [{ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }];
    } catch {
      return [];
    }
  });
  return sortBy(dated, [(x) => -x.mtime]).flatMap(({ path }) => {
    const header = sessionHeader(path);
    return header != null && resolve(header.cwd) === cwd ? [header.id] : [];
  });
}

function sessionIdFor(args: PiArgs, dir: string): string | null {
  if (args.sessionId != null) return args.sessionId;
  if (args.continueLatest) return localSessions(dir)[0] ?? crypto.randomUUID();
  if (args.session == null) return crypto.randomUUID();
  const arg = args.session;
  if (arg.includes("/") || arg.includes("\\") || arg.endsWith(".jsonl")) return null;
  const ids = localSessions(dir);
  if (ids.includes(arg)) return arg;
  const matches = ids.filter((s) => s.startsWith(arg));
  return matches.length === 1 ? matches[0]! : null;
}

function sessionExists(dirs: string[], sid: string): boolean {
  return dirs.some((dir) => sessionFiles(dir).some((f) => f.endsWith(`_${sid}.jsonl`)));
}

type Launch = { args: PiArgs; pool: PiPool; dirs: string[]; sid: string };

function managedLaunch(argv: string[]): Launch | null {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true || process.env.TOKENMAXXING_PROBE || process.env[UNMANAGED_ENV]) return null;
  const args = analyzePiArgs(argv);
  if (args == null) return null;
  const settings = piSettings(args);
  const pool = poolOf(args, settings);
  if (pool == null) {
    log("pisupervisor.unpooled", {
      provider: args.provider,
      model: args.model,
      projectTrusted: settings.projectTrusted,
      defaultProvider: (settings.projectTrusted ? settings.project.defaultProvider : undefined) ?? settings.global.defaultProvider,
    });
    return null;
  }
  const dirs = sessionDirs(args, settings);
  const sid = sessionIdFor(args, dirs[0]!);
  if (sid == null) {
    log("pisupervisor.session_unresolved", { session: args.session });
    return null;
  }
  return { args, pool, dirs, sid };
}

const RESUME_PROMPT =
  "tokenmaxxing resumed this session on an account with quota headroom. Continue the task from where the previous turn left off. If the previous turn ended waiting on the user, restate what you need and wait. The move restarted pi, which ended every command this session was still running. Relaunch what the task still needs.";

function validWanted(pool: PiPool, wanted: string | null, id: string): Account | null {
  if (wanted == null) return null;
  const a = loadAccounts(piMovers[pool].pool).accounts.find((x) => x.id === wanted);
  if (!a || a.needsReauth === true || !piStoreUsable(pool, a.id)) return null;
  if (pool === "codex" && livingPresences(codexPaths.presenceDir).some((p) => p.accountId === a.id && p.id !== id)) return null;
  return a;
}

type Watch = { decided: boolean; move: SwapDecision | null };

async function watchSeat(input: { pool: PiPool; seatId: string; id: string; families: string[] | null; overriddenUntil: number }): Promise<Watch> {
  try {
    const now = Date.now();
    const cfg = loadConfig();
    const mover = piMovers[input.pool];
    const account = loadAccounts(mover.pool).accounts.find((a) => a.id === input.seatId);
    if (!account) return { decided: false, move: null };
    const observed = input.pool === "claude" ? teeObservation(account) : await observeCodex(account, cfg, now, { probe: true, refresh: true, holder: input.id });
    const unmeasured = input.pool === "codex" && (observed == null || now - observed.at > cfg.policy.usagePollTtlMs);
    if (unmeasured) log("pisupervisor.seat_unmeasured", { seat: account.id.slice(0, 8), usageAt: observed?.at });
    const current = observed ? { ...account, windows: observed.windows } : account;
    const until = usableAt(current, { now, thresholds: thresholdBars(cfg), currentId: account.id, families: input.families, seats: null });
    if (until <= now || until <= input.overriddenUntil) return { decided: unmeasured, move: null };
    const decision = await evaluateAndMaybeSwap(mover, now, true, null, { seatId: account.id, ...(input.families ? { sessionFamilies: input.families } : {}), waiterId: input.id });
    log("pisupervisor.seat_exhausted", { pool: input.pool, seat: account.id.slice(0, 8), until, reason: decision.reason, account: decision.account?.id.slice(0, 8), waitUntil: decision.waitUntil });
    return { decided: true, move: decision.account && (decision.swapped || decision.waitUntil !== undefined) ? decision : null };
  } catch (e) {
    log("pisupervisor.seat_watch_error", { err: errorMessage(e) });
    return { decided: true, move: null };
  }
}

export async function runPiSupervisor(argv: string[]): Promise<number> {
  if (loopGuardTripped("pi")) return 1;
  let real: string;
  try {
    real = resolveRealBin(PI_BIN);
  } catch (e) {
    log("pisupervisor.resolve_failed", { err: errorMessage(e) });
    throw e;
  }
  const childEnv = { ...process.env, [WRAP_DEPTH_ENV]: String(wrapDepth() + 1) };

  let child: Subprocess | null = null;
  let terminating = false;
  let cleanup = async (): Promise<void> => {};
  process.on("SIGTERM", () => {
    terminating = true;
    if (child) {
      child.kill("SIGTERM");
      return;
    }
    cleanup().finally(() => {
      if (child) child.kill("SIGTERM");
      else process.exit(143);
    });
  });

  const launch = managedLaunch(argv);
  if (launch == null) return runPassthrough({ real, argv, env: childEnv, onSpawn: (p) => { child = p; } });
  const { args, pool, dirs, sid } = launch;

  const id = `pi-${crypto.randomUUID()}`;
  const mover = piMovers[pool];
  const presenceDir = pool === "claude" ? paths.presenceDir : codexPaths.presenceDir;
  const releaseClaim = async (): Promise<void> => {
    if (pool !== "claude") return;
    try {
      await withLock(claudePool.lockFile, () => {
        releaseWaitClaim(id);
      });
    } catch (e) {
      log("pisupervisor.claim_release_failed", { err: errorMessage(e) });
    }
  };
  cleanup = async () => {
    clearPresence({ dir: presenceDir, id });
    await releaseClaim();
  };

  const model = sessionModel(args);
  const families = pool === "claude" ? gatedFamilies(model, loadConfig().policy.switchModels) : null;
  const firstArgs = ["--session-id", sid, ...args.rest];
  let launchArgs = firstArgs;

  const savedTermios = saveTermios();
  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});
  const say = (terminal: string) => {
    process.stderr.write(terminal);
  };

  let respawns = 0;
  let wanted: string | null = null;
  let overriddenUntil = 0;
  try {
    while (true) {
      const launchedAt = Date.now();
      const launched = await withLock(mover.pool.lockFile, async () => {
        clearPresence({ dir: presenceDir, id });
        if (terminating) return null;
        const picked = validWanted(pool, wanted, id) ?? pickPiSeat(pool, launchedAt, model);
        log("pisupervisor.launch", { id, pool, respawns, seat: picked?.id.slice(0, 8) ?? null, args: launchArgs.join(" ") });
        const spawned = Bun.spawn([real, ...launchArgs], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: { ...childEnv, ...(picked ? { PI_CODING_AGENT_DIR: ensurePiStoreHome(pool, picked.id) } : {}) },
        });
        child = spawned;
        if (picked) {
          await recordPresenceOrStop({
            child: spawned,
            dir: presenceDir,
            id,
            accountId: picked.id,
            event: "pisupervisor.presence_failed",
            message: "could not write the pi session's presence file - refusing to run a session whose seat placement cannot see",
            savedTermios,
          });
        }
        if (pool === "claude") {
          try {
            releaseWaitClaim(id);
          } catch (e) {
            log("pisupervisor.claim_release_failed", { err: errorMessage(e) });
          }
        }
        return { proc: spawned, seat: picked };
      });
      if (launched == null) {
        await releaseClaim();
        return 143;
      }

      const { proc, seat } = launched;
      const pending: { move: SwapDecision | null; killed: boolean } = { move: null, killed: false };
      let seatCheckAt = 0;
      await raceMarkerOrExit({
        child: proc,
        tick: async () => {
          if (!seat || terminating || Date.now() < seatCheckAt) return false;
          const watched = await watchSeat({ pool, seatId: seat.id, id, families, overriddenUntil });
          seatCheckAt = Date.now() + (watched.decided ? SEAT_RETRY_MS : SEAT_POLL_MS);
          pending.move = watched.move;
          return watched.move !== null;
        },
        savedTermios,
        onKill: () => {
          pending.killed = true;
        },
        onError: () => clearPresence({ dir: presenceDir, id }),
        onExited: () => {
          child = null;
        },
      });

      const target = pending.killed && !terminating ? (pending.move?.account ?? null) : null;
      if (target) {
        respawns++;
        const waitUntil = pending.move?.waitUntil ?? 0;
        if (waitUntil > Date.now()) {
          if (await countdownWait(target.label, waitUntil, { stream: false, say })) overriddenUntil = waitUntil;
        } else say(`\n\x1b[36m↻ tokenmaxxing: moving pi to ${target.label} - resuming...\x1b[0m\n`);
        wanted = target.id;
        launchArgs = sessionExists(dirs, sid) ? ["--session-id", sid, ...args.flags, "--", RESUME_PROMPT] : firstArgs;
        continue;
      }
      clearPresence({ dir: presenceDir, id });
      await releaseClaim();
      log("pisupervisor.exit", { id, respawns, code: proc.exitCode, signal: proc.signalCode, terminated: terminating || undefined });
      return exitStatus(proc);
    }
  } catch (e) {
    const msg = errorMessage(e);
    say(`\n\x1b[31m${msg.startsWith("tokenmaxxing:") ? msg : `tokenmaxxing: ${msg}`}\x1b[0m\n`);
    log("pisupervisor.fatal", { err: msg });
    await releaseClaim();
    return 1;
  }
}
