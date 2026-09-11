import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { maxBy } from "es-toolkit";
import { z } from "zod";
import { paths } from "../lib/paths.ts";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, UNMANAGED_ENV, WRAP_DEPTH_ENV, WRAP_RATE_MAX, WRAP_RATE_WINDOW_MS, resolveRealClaude, wrapDepth, wrapperEntryRateTripped } from "../lib/claudebin.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { loadSessionFlags, pruneStaleSessions, saveSessionFlags } from "../lib/sessions.ts";
import { RespawnMarkerSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

const NONINTERACTIVE_SUBCMDS = new Set([
  "mcp", "config", "doctor", "update", "install", "migrate-installer",
  "setup-token", "plugin", "agents", "completion", "help",
]);

const VALUE_TAKING_ROOT_FLAGS = new Set([
  "--agent", "--agents", "--append-system-prompt", "--append-system-prompt-file",
  "--debug-file", "--effort", "--fallback-model", "--input-format",
  "--json-schema", "--max-budget-usd", "--model", "-n", "--name",
  "--output-format", "--permission-mode", "--plugin-dir", "--plugin-url",
  "--remote-control-session-name-prefix", "--setting-sources", "--settings",
  "--system-prompt",
]);
const VARIADIC_ROOT_FLAGS = new Set([
  "--add-dir", "--allowedTools", "--allowed-tools", "--betas",
  "--disallowedTools", "--disallowed-tools", "--file", "--mcp-config", "--tools",
]);
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
  return { manage, sessionId, resumeId, continueLatest };
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

const MarkerGateSchema = z.object({
  launchedAt: z.number(),
  overriddenUntil: z.number(),
});
type MarkerGate = z.infer<typeof MarkerGateSchema>;

function consumableMarker(marker: string, gate: MarkerGate): z.infer<typeof RespawnMarkerSchema> | null {
  let m: z.infer<typeof RespawnMarkerSchema>;
  try {
    m = RespawnMarkerSchema.parse(JSON.parse(readFileSync(marker, "utf8")));
  } catch (e) {
    rmSync(marker, { force: true });
    log("supervisor.marker_invalid", { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
  if (m.launchedAt !== undefined && m.launchedAt !== gate.launchedAt) {
    rmSync(marker, { force: true });
    log("supervisor.marker_stale", { markerLaunch: m.launchedAt, childLaunch: gate.launchedAt });
    return null;
  }
  if (m.waitUntil > Date.now() && m.waitUntil <= gate.overriddenUntil) {
    rmSync(marker, { force: true });
    log("supervisor.marker_overridden", { waitUntil: m.waitUntil });
    return null;
  }
  return m;
}

async function countdownWait(acct: string, until: number): Promise<boolean> {
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
  return aborted;
}

export async function runSupervisor(argv: string[]): Promise<number> {
  const depth = wrapDepth();
  if (depth >= MAX_WRAP_DEPTH) {
    console.error(
      `tokenmaxxing: ${LOOP_DIAGNOSIS} (depth ${depth}) - claudeBin in ${paths.configJson} does not launch the real Claude binary. Fix claudeBin, then run \`tokenmaxxing doctor\`.`,
    );
    log("supervisor.loop_abort", { depth });
    return 1;
  }
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

  if (!info.manage || process.env[UNMANAGED_ENV]) {
    const passthroughEnv: Record<string, string | undefined> = { ...childEnv };
    delete passthroughEnv.TOKENMAXXING_SUPERVISED;
    delete passthroughEnv.TOKENMAXXING_SESSION_ID;
    const p = Bun.spawn([real, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: passthroughEnv });
    await p.exited;
    return p.exitCode ?? (p.signalCode ? 1 : 0);
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

  let respawns = 0;
  let overriddenUntil = 0;
  while (true) {
    if (existsSync(marker)) rmSync(marker, { force: true });
    log("supervisor.launch", { sid, respawns, args: launchArgs.join(" ") });

    const gate: MarkerGate = { launchedAt: Date.now(), overriddenUntil };
    const child = Bun.spawn([real, ...launchArgs], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...childEnv, TOKENMAXXING_SUPERVISED: "1", TOKENMAXXING_SESSION_ID: sid, TOKENMAXXING_LAUNCHED_AT: String(gate.launchedAt) },
    });

    let done = false;
    const markerWatch = (async () => {
      while (!done) {
        if (existsSync(marker) && consumableMarker(marker, gate) != null) return true;
        await Bun.sleep(150);
      }
      return false;
    })();
    const exited = child.exited.then(() => { done = true; return "exit" as const; });
    const winner = await Promise.race([exited, markerWatch.then((m) => (m ? "marker" : "exit"))]);

    if (winner === "marker") {
      child.kill();
    }
    await child.exited;
    done = true;
    await markerWatch.catch(() => {});
    restoreTermios(savedTermios);

    const m = existsSync(marker) ? consumableMarker(marker, gate) : null;
    if (m) {
      rmSync(marker, { force: true });
      respawns++;
      if (m.waitUntil > Date.now()) {
        if (await countdownWait(m.account, m.waitUntil)) overriddenUntil = m.waitUntil;
      } else process.stdout.write(`\n\x1b[36m↻ tokenmaxxing: switched to ${m.account} - resuming...\x1b[0m\n`);
      saveSessionFlags(m.sessionId, persistable, process.cwd());
      launchArgs = ["--resume", m.sessionId, ...persistable, ...(m.prompt ? ["--", m.prompt] : [])];
      continue;
    }
    log("supervisor.exit", { sid, respawns, code: child.exitCode, signal: child.signalCode });
    return child.exitCode ?? (child.signalCode ? 1 : 0);
  }
}
