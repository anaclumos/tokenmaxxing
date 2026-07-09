// The `claude` supervisor. Invoked in place of claude (via ~/.config/tokenmaxxing/
// bin/claude on PATH). Runs the REAL claude with inherited stdio (claude owns the
// real terminal exactly as if run directly), pins a session id, and watches for a
// respawn marker dropped by the Stop/SessionStart hook. When the marker appears it
// SIGTERMs its own child at the (already-committed) turn boundary and relaunches
// `claude --resume <id>` on the freshly-swapped account. Process/terminal manager
// only - it never reads or proxies tokens.

import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { maxBy } from "es-toolkit";
import { z } from "zod";
import { paths } from "../lib/paths.ts";
import { resolveRealClaude } from "../lib/claudebin.ts";
import { saveTermios, restoreTermios } from "../lib/tty.ts";
import { loadSessionFlags, saveSessionFlags } from "../lib/sessions.ts";
import { RespawnMarkerSchema } from "../lib/types.ts";
import { log } from "../lib/log.ts";

const NONINTERACTIVE_SUBCMDS = new Set([
  "mcp", "config", "doctor", "update", "install", "migrate-installer",
  "setup-token", "plugin", "agents", "completion", "help",
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
  let firstPositional: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-p" || a === "--print") printMode = true;
    else if (a === "--version" || a === "-v" || a === "--help" || a === "-h") printMode = true;
    else if (a === "--session-id") sessionId = argv[++i] ?? null;
    else if (a === "-c" || a === "--continue") continueLatest = true;
    else if (a === "-r" || a === "--resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && isUuid(next)) { resumeId = next; i++; }
    } else if (!a.startsWith("-") && firstPositional === null) {
      firstPositional = a;
    }
  }

  const isSubcmd = firstPositional !== null && NONINTERACTIVE_SUBCMDS.has(firstPositional);
  const manage = !printMode && !isSubcmd && !process.env.TOKENMAXXING_PROBE;
  return { manage, sessionId, resumeId, continueLatest };
}

/** Remove session-selecting flags so we can inject our own on respawn. */
export function stripSessionFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--session-id") { i++; continue; }
    if (a === "-c" || a === "--continue") continue;
    if (a === "-r" || a === "--resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && isUuid(next)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Newest transcript session id for the current cwd (for `-c`/`-r`-without-id). */
function latestSessionForCwd(): string | null {
  const slug = process.cwd().replace(/[/.]/g, "-");
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
  process.stdout.write(`\n\x1b[36m↻ resuming on ${acct}…\x1b[0m\n`);
}

/** Entry point: `claude ...args`. */
export async function runSupervisor(argv: string[]): Promise<number> {
  const real = resolveRealClaude();
  const info = analyzeArgs(argv);

  // Pass-through: no session management, no respawn - exact stock behavior.
  if (!info.manage) {
    const p = Bun.spawn([real, ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
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
    if (persisted) base = persisted;
  }
  saveSessionFlags(sid, base, process.cwd());

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
      env: { ...process.env, TOKENMAXXING_SUPERVISED: "1", TOKENMAXXING_SESSION_ID: sid },
    });

    // Race the child's own exit against the appearance of a respawn marker.
    let done = false;
    const markerWatch = (async () => {
      while (!done) {
        if (await Bun.file(marker).exists()) return true;
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

    if (existsSync(marker)) {
      const m = RespawnMarkerSchema.parse(await Bun.file(marker).json());
      rmSync(marker, { force: true });
      respawns++;
      if (m.waitUntil && m.waitUntil > Date.now()) await countdownWait(m.account, m.waitUntil);
      else process.stdout.write(`\n\x1b[36m↻ tokenmaxxing: switched to ${m.account} - resuming…\x1b[0m\n`);
      launchArgs = ["--resume", sid, ...base];
      continue;
    }
    return child.exitCode ?? (child.signalCode ? 1 : 0);
  }
}
