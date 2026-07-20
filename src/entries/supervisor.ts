// The `claude` supervisor. Invoked in place of claude (via ~/.config/tokenmaxxing/
// bin/claude on PATH). Runs the REAL claude with inherited stdio (claude owns the
// real terminal exactly as if run directly), pins a session id, and watches for a
// respawn marker dropped by the Stop hook on a depleted-pool wait (plain swaps
// adopt in place and never respawn). When the marker appears it SIGTERMs its own
// child at the (already-committed) turn boundary, counts down to the reset, and
// relaunches `claude --resume <id>`. Process/terminal manager only - it never
// reads or proxies tokens.

import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { maxBy } from "es-toolkit";
import { z } from "zod";
import { paths } from "../lib/paths.ts";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, WRAP_DEPTH_ENV, WRAP_RATE_MAX, WRAP_RATE_WINDOW_MS, resolveRealClaude, wrapDepth, wrapperEntryRateTripped } from "../lib/claudebin.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { loadSessionFlags, pruneStaleSessions, saveSessionFlags } from "../lib/sessions.ts";
import { RespawnMarkerSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

const NONINTERACTIVE_SUBCMDS = new Set([
  "mcp", "config", "doctor", "update", "install", "migrate-installer",
  "setup-token", "plugin", "agents", "completion", "help",
]);

// Root flags whose VALUE tokens must never be read as the subcommand (e.g.
// `--settings config` is an interactive session, not `claude config`): the
// same hardening class shouldManageCodex got. Split by arity, mirroring
// claude's own commander declarations (--help-verified 2.1.215; claude changes
// monthly - a newly added value-taking flag regresses only that flag's
// collision case). `--session-id` / `-r` / `--resume` consume their values in
// dedicated branches below.
const VALUE_TAKING_ROOT_FLAGS = new Set([
  "--agent", "--agents", "--append-system-prompt", "--append-system-prompt-file",
  "--debug-file", "--effort", "--fallback-model", "--input-format",
  "--json-schema", "--max-budget-usd", "--model", "-n", "--name",
  "--output-format", "--permission-mode", "--plugin-dir", "--plugin-url",
  "--remote-control-session-name-prefix", "--setting-sources", "--settings",
  "--system-prompt",
]);
// Variadic (`<x...>`): commander consumes EVERY following non-dash token.
const VARIADIC_ROOT_FLAGS = new Set([
  "--add-dir", "--allowedTools", "--allowed-tools", "--betas",
  "--disallowedTools", "--disallowed-tools", "--file", "--mcp-config", "--tools",
]);
// Optional value (`[x]`): commander consumes the next token unless it is a flag.
const OPTIONAL_VALUE_ROOT_FLAGS = new Set([
  "-d", "--debug", "--from-pr", "--prompt-suggestions", "--remote-control", "-w", "--worktree",
]);

const isUuid = (s: string) => z.uuid().safeParse(s).success;

const AnalysisSchema = z.object({
  manage: z.boolean(),
  sessionId: z.string().nullable(),
  resumeId: z.string().nullable(),
  continueLatest: z.boolean(),
});
type Analysis = z.infer<typeof AnalysisSchema>;

export function analyzeArgs(argv: string[]): Analysis {
  let sessionId: string | null = null;
  let resumeId: string | null = null;
  let continueLatest = false;
  let printMode = false;
  let invalidSessionArg = false;
  let pickerResume = false;
  let forkSession = false;
  let firstPositional: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-p" || a === "--print") printMode = true;
    else if (a === "--version" || a === "-v" || a === "--help" || a === "-h") printMode = true;
    else if (a === "--session-id") {
      // A non-UUID here must never become supervisor state: the sid names the
      // respawn-marker and session-flag paths (an unvalidated value could
      // traverse out of them), and real claude rejects a malformed id anyway -
      // pass it through unmanaged and let claude do the rejecting.
      const next = argv[++i] ?? null;
      if (next && isUuid(next)) sessionId = next;
      else invalidSessionArg = true;
    }
    else if (a === "-c" || a === "--continue") continueLatest = true;
    else if (a === "-r" || a === "--resume") {
      // A UUID resume is managed (the sid is known, marker paths can be
      // pinned). Bare `-r`, or `-r <term>` (binary-verified 2.1.214: a non-id
      // value is an interactive-picker SEARCH TERM), choose the sid INSIDE
      // claude - the supervisor cannot pin marker paths for an unknown sid, so
      // those pass through unmanaged and claude behaves exactly as without the
      // wrapper (same accepted state as claude's bg-daemon sessions: swaps
      // still adopt in place, hooks still fire; only the depleted-pool
      // countdown is absent).
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && isUuid(next)) { resumeId = next; i++; }
      else pickerResume = true;
    }
    else if (a === "--fork-session") forkSession = true;
    // commander's `--flag=value` forms (closing-review catch: unrecognized,
    // they were skipped as unknown dash-args, so the supervisor pinned a
    // fresh random sid while claude ran the flag-selected session - markers
    // and session flags landed under an id nothing was running).
    else if (a.startsWith("--session-id=")) {
      const value = a.slice("--session-id=".length);
      if (isUuid(value)) sessionId = value;
      else invalidSessionArg = true;
    }
    else if (a.startsWith("--resume=")) {
      const value = a.slice("--resume=".length);
      if (isUuid(value)) resumeId = value;
      else pickerResume = true;
    }
    else if (VALUE_TAKING_ROOT_FLAGS.has(a)) i++;
    else if (VARIADIC_ROOT_FLAGS.has(a)) {
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) i++;
    }
    else if (OPTIONAL_VALUE_ROOT_FLAGS.has(a)) {
      if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-")) i++;
    }
    else if (!a.startsWith("-") && firstPositional === null) {
      firstPositional = a;
    }
  }

  const isSubcmd = firstPositional !== null && NONINTERACTIVE_SUBCMDS.has(firstPositional);
  // A forked resume gets a NEW session id chosen inside claude, so the
  // supervisor cannot pin marker paths - pass through unmanaged like
  // picker-mode resume (closing-review catch: managing it paired the marker
  // to the stale pre-fork sid, and a respawn would fork yet another session).
  const forkResume = forkSession && (resumeId !== null || continueLatest);
  const manage = !printMode && !isSubcmd && !invalidSessionArg && !pickerResume && !forkResume && !process.env.TOKENMAXXING_PROBE;
  return { manage, sessionId, resumeId, continueLatest };
}

/** Remove session-selecting flags so we can inject our own on respawn. Managed
 *  argv can only carry a UUID-valued resume (picker-mode passes through
 *  unmanaged), so the value is always consumed with its flag. */
export function stripSessionFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--session-id") { i++; continue; }
    if (a === "-c" || a === "--continue") continue;
    if (a === "-r" || a === "--resume") { i++; continue; }
    // the commander `=` forms carry their value in the same token
    if (a.startsWith("--session-id=") || a.startsWith("--resume=")) continue;
    // --fork-session must not survive into respawn args: bare `--fork-session`
    // is inert and stays managed, but a depleted-pool respawn injects
    // `--resume <sid>` - with the flag still present claude would FORK to a
    // NEW session id, permanently unpairing the supervisor's marker path from
    // the running session (closing-review catch).
    if (a === "--fork-session") continue;
    out.push(a);
  }
  return out;
}

/** Remove positional tokens (the one-shot initial prompt) while keeping every
 *  flag and its consumed value(s). A positional is a submit-once user turn:
 *  persisting or replaying it on a respawn / later `--resume` re-injects the
 *  original instruction into an already-progressed session (adversarial-review
 *  HIGH catch) - only real flags like --model belong in sessions/ files and
 *  respawn args. */
export function stripPositionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // `--` ends option parsing: everything after it is positional (a prompt
    // deliberately starting with "-"), never a flag to persist (PR #37
    // review catch). The delimiter itself is dropped with them.
    if (a === "--") break;
    if (!a.startsWith("-")) continue;
    out.push(a);
    if (VALUE_TAKING_ROOT_FLAGS.has(a)) {
      if (i + 1 < argv.length) out.push(argv[++i]!);
    } else if (VARIADIC_ROOT_FLAGS.has(a)) {
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) out.push(argv[++i]!);
    } else if (OPTIONAL_VALUE_ROOT_FLAGS.has(a)) {
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) out.push(argv[++i]!);
    }
  }
  return out;
}

/** Newest transcript session id for the current cwd (for `-c`). claude's
 *  project-dir slug maps EVERY non-alphanumeric char to "-": the regex below
 *  mirrors claude's own, byte for byte (binary-verified 2.1.215, the external-
 *  contract regex exception). The old [/.]-only mapping missed underscores
 *  etc., so `-c` in such a cwd silently opened a brand-new session instead of
 *  continuing (closing-review catch). */
function latestSessionForCwd(): string | null {
  const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
  const projDir = join(paths.claudeDir, "projects", slug);
  if (!existsSync(projDir)) return null;
  try {
    const files = readdirSync(projDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(projDir, f)).mtimeMs }));
    const newest = maxBy(files, (x) => x.m);
    return newest ? newest.f.replace(/\.jsonl$/, "") : null;
  } catch {
    return null;
  }
}

/** Read + validate a respawn marker. An unparseable one (a version-skew hook,
 *  corruption) is dropped loudly and reported as absent: the watcher checks
 *  validity BEFORE the SIGTERM, so garbage can never kill the session, and the
 *  post-exit consume can never throw after the child is already dead (PR #36
 *  review catch). */
function consumableMarker(marker: string): z.infer<typeof RespawnMarkerSchema> | null {
  try {
    return RespawnMarkerSchema.parse(JSON.parse(readFileSync(marker, "utf8")));
  } catch (e) {
    rmSync(marker, { force: true });
    log("supervisor.marker_invalid", { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Interruptible countdown until `until`, shown in the terminal (claude is dead,
 *  so the statusLine can't render it). Ctrl-C resumes immediately. */
async function countdownWait(acct: string, until: number): Promise<void> {
  let aborted = false;
  const onInt = () => { aborted = true; };
  process.on("SIGINT", onInt);
  process.stdout.write(`\n\x1b[36m⏳ tokenmaxxing: all accounts at their limit. Resuming on ${acct} when it resets (Ctrl-C to resume now).\x1b[0m\n`);
  while (!aborted && Date.now() < until) {
    const left = until - Date.now();
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    process.stdout.write(`\r\x1b[36m   resuming in ${m}m ${String(s).padStart(2, "0")}s \x1b[0m`);
    await Bun.sleep(1000);
  }
  process.removeListener("SIGINT", onInt);
  process.stdout.write(`\n\x1b[36m↻ resuming on ${acct}...\x1b[0m\n`);
}

/** Entry point: `claude ...args`. */
export async function runSupervisor(argv: string[]): Promise<number> {
  // Depth cap: every spawn below tags its child, so a claudeBin that leads back
  // here (pinned shim re-execing `claude` from PATH) dies at a handful of
  // processes instead of fork-bombing the machine (2026-07-12 incident).
  const depth = wrapDepth();
  if (depth >= MAX_WRAP_DEPTH) {
    console.error(
      `tokenmaxxing: ${LOOP_DIAGNOSIS} (depth ${depth}) - claudeBin in ${paths.configJson} does not launch the real Claude binary. Fix claudeBin, then run \`tokenmaxxing doctor\`.`,
    );
    log("supervisor.loop_abort", { depth });
    return 1;
  }
  // Rate backstop: an env-sanitizing shim in the loop strips the sentinel, but
  // it cannot erase the on-disk entry counter.
  if (wrapperEntryRateTripped(Date.now())) {
    console.error(
      `tokenmaxxing: ${LOOP_DIAGNOSIS} (over ${WRAP_RATE_MAX} wrapper entries in ${WRAP_RATE_WINDOW_MS / 1000}s) - claudeBin in ${paths.configJson} does not launch the real Claude binary. Fix claudeBin, then run \`tokenmaxxing doctor\`.`,
    );
    log("supervisor.rate_abort", { max: WRAP_RATE_MAX });
    return 1;
  }
  const real = resolveRealClaude();
  const info = analyzeArgs(argv);
  const childEnv = { ...process.env, [WRAP_DEPTH_ENV]: String(depth + 1) };

  // Pass-through: no session management, no respawn - exact stock behavior.
  if (!info.manage) {
    // STRIP the supervision pairing env (mirrors the codex shim's passthrough
    // arm, closing-review catch): a nested unmanaged claude inside a
    // supervised session (e.g. the agent running `claude -p ...`) would
    // otherwise inherit TOKENMAXXING_SUPERVISED/TOKENMAXXING_SESSION_ID, and
    // its Stop hooks - which DO fire in print mode - would compute
    // canPause=true and could anticipatorily pre-park the pool against a
    // marker path the OUTER supervisor owns.
    const passthroughEnv: Record<string, string | undefined> = { ...childEnv };
    delete passthroughEnv.TOKENMAXXING_SUPERVISED;
    delete passthroughEnv.TOKENMAXXING_SESSION_ID;
    const p = Bun.spawn([real, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: passthroughEnv });
    await p.exited;
    return p.exitCode ?? (p.signalCode ? 1 : 0);
  }

  // Decide the managed session id + whether we're resuming an existing one.
  let base = stripSessionFlags(argv);
  let sid: string;
  let resuming = false;
  if (info.sessionId) {
    sid = info.sessionId;
  } else if (info.resumeId) {
    sid = info.resumeId;
    resuming = true;
  } else if (info.continueLatest) {
    const latest = latestSessionForCwd();
    if (latest) { sid = latest; resuming = true; } else sid = crypto.randomUUID();
  } else {
    sid = crypto.randomUUID();
  }

  // Restore the original launch flags when resuming a session with none given
  // this time (a bare `claude --resume <id>`, or the depleted-pool recovery).
  if (resuming && base.length === 0) {
    const persisted = loadSessionFlags(sid);
    // enforce the flags-only contract at the trust boundary, not just at
    // write: a sessions/ file written before stripPositionals existed can
    // still carry the original prompt, and restoring it verbatim would
    // re-submit that prompt on a bare `claude --resume` (PR #37 review
    // catch). Idempotent on well-formed files.
    if (persisted) base = stripPositionals(persisted);
  }
  // The FIRST launch keeps a positional prompt (the user just typed it);
  // everything persisted or respawned carries flags only.
  const persistable = stripPositionals(base);
  saveSessionFlags(sid, persistable, process.cwd());
  pruneStaleSessions(Date.now());

  let launchArgs = resuming ? ["--resume", sid, ...base] : ["--session-id", sid, ...base];

  mkdirSync(paths.respawnDir, { recursive: true });
  const marker = join(paths.respawnDir, sid);
  const savedTermios = saveTermios();

  // Supervisor survives the SIGINT/SIGHUP that flow to the foreground group;
  // claude (the child, same pgrp) receives and handles them itself.
  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});

  let respawns = 0;
  while (true) {
    if (existsSync(marker)) rmSync(marker, { force: true });
    log("supervisor.launch", { sid, respawns, args: launchArgs.join(" ") });

    const child = Bun.spawn([real, ...launchArgs], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...childEnv, TOKENMAXXING_SUPERVISED: "1", TOKENMAXXING_SESSION_ID: sid },
    });

    // Race the child's own exit against the appearance of a respawn marker.
    let done = false;
    const markerWatch = (async () => {
      while (!done) {
        if (existsSync(marker) && consumableMarker(marker) != null) return true;
        await Bun.sleep(150);
      }
      return false;
    })();
    const exited = child.exited.then(() => { done = true; return "exit" as const; });
    const winner = await Promise.race([exited, markerWatch.then((m) => (m ? "marker" : "exit"))]);

    if (winner === "marker") {
      child.kill(); // SIGTERM at the committed turn boundary
    }
    await child.exited;
    done = true;
    await markerWatch.catch(() => {});
    restoreTermios(savedTermios);

    const m = existsSync(marker) ? consumableMarker(marker) : null;
    if (m) {
      rmSync(marker, { force: true });
      respawns++;
      if (m.waitUntil > Date.now()) await countdownWait(m.account, m.waitUntil);
      else process.stdout.write(`\n\x1b[36m↻ tokenmaxxing: switched to ${m.account} - resuming...\x1b[0m\n`);
      // resume the marker's CURRENT transcript, not the pinned id: after
      // /clear they differ, and resuming the pinned id would revive the
      // pre-/clear conversation (closing-review HIGH catch). Persist the
      // flags under that transcript id too, so a later bare
      // `claude --resume <id>` restores them (PR #36 review catch). FLAGS
      // only: replaying a positional prompt would re-submit it as a fresh
      // turn on the progressed session (adversarial-review HIGH catch).
      saveSessionFlags(m.sessionId, persistable, process.cwd());
      launchArgs = ["--resume", m.sessionId, ...persistable];
      continue;
    }
    // No marker: claude exited on its own (quit, crash, resume refused). Log it -
    // "the process just exited" is undiagnosable without the code/signal.
    log("supervisor.exit", { sid, respawns, code: child.exitCode, signal: child.signalCode });
    return child.exitCode ?? (child.signalCode ? 1 : 0);
  }
}
