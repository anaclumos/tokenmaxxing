import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { FileSink, Subprocess } from "bun";
import { maxBy } from "es-toolkit";
import { z } from "zod";
import { claudePool, paths, storeDirFor } from "../lib/paths.ts";
import { CLAUDE_BIN, UNMANAGED_ENV, WRAP_DEPTH_ENV, resolveRealBin, wrapDepth } from "../lib/claudebin.ts";
import { claude, pickSeat } from "../lib/claude.ts";
import { compactClaudeSession } from "../lib/compact.ts";
import { evaluateAndMaybeSwap } from "../lib/decide.ts";
import { withLock } from "../lib/lock.ts";
import { thresholdBars, usableAt } from "../lib/picker.ts";
import { clearPresence } from "../lib/presence.ts";
import { readLines } from "../lib/proc.ts";
import { teeObservation } from "../lib/sample.ts";
import { countdownWait, exitStatus, loopGuardTripped, raceMarkerOrExit, recordPresenceOrStop, runPassthrough, SEAT_POLL_MS, SEAT_RETRY_MS, type Say } from "../lib/supervise.ts";
import { saveTermios } from "../lib/tty.ts";
import { liveSessionId, loadSessionFlags, pruneStaleSessions, saveSessionFlags, writeRespawnMarker } from "../lib/sessions.ts";
import { loadAccounts, loadConfig, readJsonFile, releaseWaitClaim } from "../lib/state.ts";
import { gatedFamilies, modelFromFlag } from "../lib/usage.ts";
import { RespawnMarkerSchema, type Account, type Config, type ModelInfo } from "../lib/types.ts";
import { errorMessage, log } from "../lib/log.ts";

const NONINTERACTIVE_SUBCMDS = new Set([
  "mcp", "config", "doctor", "update", "install", "migrate-installer",
  "setup-token", "plugin", "agents", "completion", "help",
]);

const VALUE_TAKING_ROOT_FLAGS = new Set([
  "--agent", "--agents", "--append-system-prompt", "--append-system-prompt-file",
  "--autocompact", "--debug-file", "--effort", "--environment", "--fallback-model",
  "--input-format", "--json-schema", "--managed-settings", "--max-budget-usd",
  "--max-thinking-tokens", "--max-turns", "--model", "-n", "--name",
  "--output-format", "--permission-mode", "--permission-prompt-tool", "--permission-prompts",
  "--plugin-dir", "--plugin-dir-no-mcp", "--plugin-url", "--remote-control-session-name-prefix",
  "--setting-sources", "--settings", "--system-prompt", "--system-prompt-snapshot",
  "--task-budget", "--thinking", "--thinking-display",
]);
const VARIADIC_ROOT_FLAGS = new Set([
  "--add-dir", "--allowedTools", "--allowed-tools", "--betas",
  "--disallowedTools", "--disallowed-tools", "--file", "--mcp-config", "--tools",
]);
const OPTIONAL_VALUE_ROOT_FLAGS = new Set([
  "--cloud", "-d", "--debug", "--from-pr", "--prompt-suggestions", "--remote-control",
  "--teleport", "-w", "--worktree",
]);

const isUuid = (s: string) => z.uuid().safeParse(s).success;

type Analysis = {
  manage: boolean;
  sessionId: string | null;
  resumeId: string | null;
  continueLatest: boolean;
  streamInput: boolean;
  streamOutput: boolean;
  model: string | null;
};

export function analyzeArgs(argv: string[]): Analysis {
  let sessionId: string | null = null;
  let resumeId: string | null = null;
  let continueLatest = false;
  let streamInput = false;
  let streamOutput = false;
  let model: string | null = null;
  let printMode = false;
  let invalidSessionArg = false;
  let pickerResume = false;
  let forkSession = false;
  let firstPositional: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    else if (a === "-p" || a === "--print") printMode = true;
    else if (a === "--version" || a === "-v" || a === "--help" || a === "-h") printMode = true;
    else if (a === "--session-id") {
      const next = argv[++i] ?? null;
      if (next && isUuid(next)) sessionId = next;
      else invalidSessionArg = true;
    }
    else if (a === "-c" || a === "--continue") continueLatest = true;
    else if (a === "-r" || a === "--resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && isUuid(next)) { resumeId = next; i++; }
      else pickerResume = true;
    }
    else if (a === "--fork-session") forkSession = true;
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
    else if (a === "--input-format") streamInput = argv[++i] === "stream-json";
    else if (a.startsWith("--input-format=")) streamInput = a.slice("--input-format=".length) === "stream-json";
    else if (a === "--output-format") streamOutput = argv[++i] === "stream-json";
    else if (a.startsWith("--output-format=")) streamOutput = a.slice("--output-format=".length) === "stream-json";
    else if (a === "--model") model = argv[++i] ?? null;
    else if (a.startsWith("--model=")) model = a.slice("--model=".length);
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
  const forkResume = forkSession && (resumeId !== null || continueLatest);
  const manage = !printMode && !isSubcmd && !invalidSessionArg && !pickerResume && !forkResume && !process.env.TOKENMAXXING_PROBE;
  return { manage, sessionId, resumeId, continueLatest, streamInput, streamOutput, model };
}

export function stripSessionFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--session-id") { i++; continue; }
    if (a === "-c" || a === "--continue") continue;
    if (a === "-r" || a === "--resume") { i++; continue; }
    if (a.startsWith("--session-id=") || a.startsWith("--resume=")) continue;
    if (a === "--fork-session") continue;
    out.push(a);
  }
  return out;
}

export function stripPositionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
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

function projectDirForCwd(): string {
  return join(paths.claudeDir, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
}

function transcriptPath(sessionId: string): string {
  return join(projectDirForCwd(), `${sessionId}.jsonl`);
}

function latestSessionForCwd(): string | null {
  const projDir = projectDirForCwd();
  if (!existsSync(projDir)) return null;
  try {
    const files = readdirSync(projDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(projDir, f)).mtimeMs }));
    const newest = maxBy(files, (x) => x.m);
    return newest ? basename(newest.f, ".jsonl") : null;
  } catch {
    return null;
  }
}

type MarkerGate = {
  launchedAt: number;
  overriddenUntil: number;
};

function releaseClaimLocked(sid: string): void {
  try {
    releaseWaitClaim(sid);
  } catch (e) {
    log("supervisor.claim_release_failed", { err: errorMessage(e) });
  }
}

async function discardMarker(marker: string, event: string, fields: Record<string, unknown>): Promise<null> {
  await withLock(claudePool.lockFile, () => {
    rmSync(marker, { force: true });
    releaseClaimLocked(basename(marker));
  });
  log(event, fields);
  return null;
}

async function consumableMarker(marker: string, gate: MarkerGate): Promise<z.infer<typeof RespawnMarkerSchema> | null> {
  let m: z.infer<typeof RespawnMarkerSchema>;
  try {
    m = readJsonFile(marker, RespawnMarkerSchema);
  } catch (e) {
    log("supervisor.marker_invalid", { err: errorMessage(e) });
    throw new Error(
      `tokenmaxxing: the session was stopped because the respawn marker is corrupt. Inspect ${marker}, then run \`claude --resume ${basename(marker)}\` (a fresh launch clears it)`,
    );
  }
  if (m.launchedAt !== undefined && m.launchedAt !== gate.launchedAt) {
    return discardMarker(marker, "supervisor.marker_stale", { markerLaunch: m.launchedAt, childLaunch: gate.launchedAt });
  }
  if (m.waitUntil > Date.now() && m.waitUntil <= gate.overriddenUntil) {
    return discardMarker(marker, "supervisor.marker_overridden", { waitUntil: m.waitUntil });
  }
  return m;
}

function seatBlockedUntil(seatId: string, now: number, families: string[], cfg: Config): number | null {
  const account = loadAccounts(claudePool).accounts.find((a) => a.id === seatId);
  if (!account) return null;
  const observed = teeObservation(account);
  const current = observed ? { ...account, windows: observed.windows } : account;
  const until = usableAt(current, { now, thresholds: thresholdBars(cfg), currentId: seatId, families, seats: null });
  return until > now ? until : null;
}

async function moveExhaustedSeat(seat: Account, sid: string, gate: MarkerGate, model: ModelInfo | null): Promise<boolean> {
  try {
    const now = Date.now();
    const cfg = loadConfig();
    const families = gatedFamilies(model, cfg.policy.switchModels);
    const until = seatBlockedUntil(seat.id, now, families, cfg);
    if (until == null || until <= gate.overriddenUntil) return false;
    const decision = await evaluateAndMaybeSwap(claude, now, true, null, { seatId: seat.id, sessionFamilies: families, waiterId: sid });
    log("supervisor.seat_exhausted", { seat: seat.id.slice(0, 8), until, reason: decision.reason, account: decision.account?.id.slice(0, 8), waitUntil: decision.waitUntil });
    if (decision.account && (decision.swapped || decision.waitUntil !== undefined)) {
      writeRespawnMarker({ session: { sid, launchedAt: gate.launchedAt, live: liveSessionId(sid) }, accountId: decision.account.id, waitUntil: decision.waitUntil ?? now, compact: true, origin: "seatwatch" });
    }
  } catch (e) {
    log("supervisor.seat_watch_error", { err: errorMessage(e) });
  }
  return true;
}

function systemLine(sid: string, text: string): string {
  return `${JSON.stringify({ type: "system", subtype: "informational", content: text, level: "warning", uuid: crypto.randomUUID(), session_id: sid })}\n`;
}

function resumePrompt(input: { compacted: boolean; origin: z.infer<typeof RespawnMarkerSchema>["origin"] }): string {
  const moved = input.compacted
    ? "tokenmaxxing compacted this conversation and resumed the session on an account with quota headroom."
    : "tokenmaxxing resumed this session on an account with quota headroom.";
  if (input.origin === "stop") {
    return `${moved} The previous turn finished before the move. If it waited on the user or completed the task, end this turn without restating it. If it waited on a background Bash task, Monitor, or Workflow run, relaunch that work, because the move ended it.`;
  }
  return `${moved} Continue the task from where the previous turn left off. If the previous turn ended waiting on the user, restate what you need and wait. The move restarted Claude Code, which ended every background Bash task, Monitor, and Workflow run this session started. Relaunch what the task still needs.`;
}

function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

class StdinRelay {
  private sink: FileSink | null = null;
  private queue: string[] = [];
  private ended = false;

  constructor() {
    this.pump()
      .catch((e: unknown) => log("supervisor.relay_read_failed", { err: errorMessage(e) }))
      .finally(() => {
        this.ended = true;
        this.close();
      });
  }

  attach(sink: FileSink, first: string | null): void {
    this.sink = sink;
    const lines = first === null ? this.queue : [first, ...this.queue];
    this.queue = [];
    for (const line of lines) this.forward(line);
    if (this.ended) this.close();
  }

  detach(): void {
    this.sink = null;
  }

  private async pump(): Promise<void> {
    for await (const line of readLines(Bun.stdin.stream())) this.forward(`${line}\n`);
  }

  private forward(line: string): void {
    if (this.sink !== null) {
      try {
        this.sink.write(line);
        this.sink.flush();
        return;
      } catch (e) {
        log("supervisor.relay_write_failed", { err: errorMessage(e) });
        this.sink = null;
      }
    }
    this.queue.push(line);
  }

  private close(): void {
    if (this.sink === null) return;
    try {
      this.sink.end();
    } catch (e) {
      log("supervisor.relay_end_failed", { err: errorMessage(e) });
    }
    this.sink = null;
  }
}

function bareResumeStream(info: Analysis, argv: string[], sid: string | null): boolean {
  if (!info.manage || process.env[UNMANAGED_ENV] || info.sessionId != null || stripSessionFlags(argv).length !== 0 || sid == null) return false;
  try {
    const persisted = loadSessionFlags(sid);
    return persisted != null && analyzeArgs(persisted).streamOutput;
  } catch {
    return false;
  }
}

export async function runSupervisor(argv: string[]): Promise<number> {
  const info = analyzeArgs(argv);
  const drivenSid = info.sessionId ?? info.resumeId ?? (info.continueLatest ? latestSessionForCwd() : null);
  const earlyStream = info.streamOutput || bareResumeStream(info, argv, drivenSid);
  const earlySid = drivenSid ?? crypto.randomUUID();
  if (loopGuardTripped("claude")) {
    if (earlyStream) {
      process.stdout.write(systemLine(earlySid, "tokenmaxxing: wrapper re-entered without reaching the real Claude. Fix claudeBin, then run tokenmaxxing doctor."));
    }
    return 1;
  }
  let real: string;
  try {
    real = resolveRealBin(CLAUDE_BIN);
  } catch (e) {
    if (!earlyStream) throw e;
    process.stdout.write(systemLine(earlySid, `tokenmaxxing: ${errorMessage(e)}`));
    log("supervisor.resolve_failed", { err: errorMessage(e) });
    return 1;
  }
  const childEnv = { ...process.env, [WRAP_DEPTH_ENV]: String(wrapDepth() + 1) };

  let child: Subprocess | null = null;
  let terminating = false;
  let claimSid: string | null = null;
  const releaseClaim = async (): Promise<void> => {
    const claimed = claimSid;
    if (claimed == null) return;
    try {
      await withLock(claudePool.lockFile, () => {
        releaseWaitClaim(claimed);
      });
    } catch (e) {
      log("supervisor.claim_release_failed", { err: errorMessage(e) });
    }
  };
  process.on("SIGTERM", () => {
    terminating = true;
    const released = releaseClaim();
    if (child) {
      child.kill("SIGTERM");
      void released;
    } else {
      released.finally(() => process.exit(143));
    }
  });

  if (!info.manage || process.env[UNMANAGED_ENV]) {
    const passthroughEnv: Record<string, string | undefined> = { ...childEnv };
    delete passthroughEnv.TOKENMAXXING_SUPERVISED;
    delete passthroughEnv.TOKENMAXXING_SESSION_ID;
    delete passthroughEnv.TOKENMAXXING_MODEL;
    delete passthroughEnv.TOKENMAXXING_REFUSED;
    return runPassthrough({ real, argv, env: passthroughEnv, onSpawn: (p) => { child = p; } });
  }

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
  claimSid = sid;

  if (resuming && base.length === 0) {
    const persisted = loadSessionFlags(sid);
    if (persisted) base = stripPositionals(persisted);
  }
  const persistable = stripPositionals(base);
  saveSessionFlags(sid, persistable, process.cwd());
  pruneStaleSessions(Date.now());

  let launchArgs = resuming ? ["--resume", sid, ...base] : ["--session-id", sid, ...base];

  mkdirSync(paths.respawnDir, { recursive: true });
  const marker = join(paths.respawnDir, sid);
  const savedTermios = saveTermios();

  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});

  const effective = analyzeArgs(base);
  const relay = effective.streamInput ? new StdinRelay() : null;
  const stream = effective.streamOutput;
  const model = modelFromFlag(effective.model);
  let noticeSid = sid;
  const say: Say = (terminal, text) => {
    if (stream) process.stdout.write(systemLine(noticeSid, text));
    else process.stderr.write(terminal);
  };
  let firstLine: string | null = null;
  let respawns = 0;
  let overriddenUntil = 0;
  let wanted: string | null = null;
  let refused: string[] = [];
  try {
  while (true) {
    if (existsSync(marker)) rmSync(marker, { force: true });

    const gate: MarkerGate = { launchedAt: Date.now(), overriddenUntil };
    const launched = await withLock(claudePool.lockFile, async () => {
      if (terminating) return null;
      const picked = (wanted == null ? null : (loadAccounts(claudePool).accounts.find((a) => a.id === wanted) ?? null)) ?? pickSeat(gate.launchedAt, model);
      log("supervisor.launch", { sid, respawns, seat: picked?.id.slice(0, 8) ?? null, args: launchArgs.join(" "), injected: firstLine !== null });
      const spawned = Bun.spawn([real, ...launchArgs], {
        stdin: relay === null ? "inherit" : "pipe",
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ...childEnv,
          TOKENMAXXING_SUPERVISED: "1",
          TOKENMAXXING_SESSION_ID: sid,
          TOKENMAXXING_LAUNCHED_AT: String(gate.launchedAt),
          TOKENMAXXING_MODEL: effective.model ?? "",
          TOKENMAXXING_REFUSED: refused.join(","),
          ...(picked ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: storeDirFor(picked.id) } : {}),
        },
      });
      child = spawned;
      if (relay !== null) relay.attach(spawned.stdin!, firstLine);
      firstLine = null;
      if (picked) {
        await recordPresenceOrStop({
          child: spawned,
          dir: paths.presenceDir,
          id: sid,
          accountId: picked.id,
          event: "supervisor.presence_failed",
          message: "could not write the session presence file - refusing to run a session whose seat placement cannot see",
          savedTermios,
        });
      }
      releaseClaimLocked(sid);
      return { child: spawned, seat: picked };
    });
    if (launched == null) {
      await releaseClaim();
      return 143;
    }

    const { child: proc, seat } = launched;
    let seatCheckAt = 0;
    await raceMarkerOrExit({
      child: proc,
      tick: async () => {
        if (existsSync(marker) && (await consumableMarker(marker, gate)) != null) return true;
        if (seat && !terminating && Date.now() >= seatCheckAt) {
          const decided = await moveExhaustedSeat(seat, sid, gate, model);
          seatCheckAt = Date.now() + (decided ? SEAT_RETRY_MS : SEAT_POLL_MS);
        }
        return false;
      },
      savedTermios,
      onKill: () => relay?.detach(),
      onError: () => clearPresence({ dir: paths.presenceDir, id: sid }),
      onExited: () => {
        child = null;
        relay?.detach();
      },
    });

    const m = !terminating && existsSync(marker) ? await consumableMarker(marker, gate) : null;
    if (m) {
      rmSync(marker, { force: true });
      respawns++;
      noticeSid = m.sessionId;
      const accounts = loadAccounts(claudePool).accounts;
      const label = accounts.find((a) => a.id === m.accountId)?.label ?? m.accountId.slice(0, 8);
      const walledUntil = accounts.find((a) => a.id === seat?.id)?.enforcedUntil ?? 0;
      const transcript = transcriptPath(m.sessionId);
      const resumable = existsSync(transcript);
      let compacted = false;
      if (m.compact && seat && resumable && walledUntil > Date.now()) {
        log("supervisor.compact_skipped", { sid: m.sessionId.slice(0, 8), seat: seat.id.slice(0, 8), until: walledUntil });
      } else if (m.compact && seat && resumable) {
        say(`\n\x1b[36m↻ tokenmaxxing: compacting the conversation on ${seat.label} before the move...\x1b[0m\n`, `tokenmaxxing: compacting the conversation on ${seat.label} before the move.`);
        const compactEnv: Record<string, string | undefined> = { ...childEnv, TOKENMAXXING_PROBE: "1", CLAUDE_SECURESTORAGE_CONFIG_DIR: storeDirFor(seat.id) };
        delete compactEnv.TOKENMAXXING_SUPERVISED;
        delete compactEnv.TOKENMAXXING_SESSION_ID;
        delete compactEnv.TOKENMAXXING_LAUNCHED_AT;
        delete compactEnv.TOKENMAXXING_MODEL;
        delete compactEnv.TOKENMAXXING_REFUSED;
        const outcome = await compactClaudeSession({ real, sid: m.sessionId, transcript, env: compactEnv, onSpawn: (p) => { child = p; } });
        child = null;
        if (terminating) {
          await releaseClaim();
          return 143;
        }
        log("supervisor.compact", { sid: m.sessionId.slice(0, 8), seat: seat.id.slice(0, 8), ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason });
        if (!outcome.ok) say(`\x1b[33m   compaction did not land (${outcome.reason}) - resuming with the full context\x1b[0m\n`, `tokenmaxxing: compaction did not land; resuming with the full context. (${outcome.reason})`);
        compacted = outcome.ok;
      }
      if (m.waitUntil > Date.now()) {
        if (await countdownWait(label, m.waitUntil, { stream, say })) overriddenUntil = m.waitUntil;
      } else say(`\n\x1b[36m↻ tokenmaxxing: moving to ${label} - resuming...\x1b[0m\n`, `tokenmaxxing: moving to ${label} and resuming.`);
      wanted = m.accountId;
      refused = m.refused ?? refused;
      saveSessionFlags(m.sessionId, persistable, process.cwd());
      const prompt = resumable ? resumePrompt({ compacted, origin: m.origin }) : null;
      firstLine = relay !== null && prompt !== null ? userLine(prompt) : null;
      launchArgs = [resumable ? "--resume" : "--session-id", m.sessionId, ...(relay === null && prompt !== null ? [prompt] : []), ...persistable];
      continue;
    }
    clearPresence({ dir: paths.presenceDir, id: sid });
    await releaseClaim();
    log("supervisor.exit", { sid, respawns, code: proc.exitCode, signal: proc.signalCode, terminated: terminating || undefined });
    return exitStatus(proc);
  }
  } catch (e) {
    const msg = errorMessage(e);
    const text = msg.startsWith("tokenmaxxing:") ? msg : `tokenmaxxing: ${msg}`;
    say(`\n\x1b[31m${text}\x1b[0m\n`, text);
    log("supervisor.fatal", { err: msg });
    await releaseClaim();
    return 1;
  }
}
