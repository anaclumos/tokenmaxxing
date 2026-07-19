// Resolve the REAL claude binary (never our shim on PATH).

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { uniq } from "es-toolkit";
import { z } from "zod";
import { paths } from "./paths.ts";
import { loadConfig } from "./state.ts";
import { writeFileAtomic } from "./atomic.ts";

/** How many tokenmaxxing wrappers sit above this process. Every supervisor
 *  spawn increments it in the child env; the wrapper refuses to run at the cap,
 *  so ANY claudeBin indirection that leads back to the wrapper (a pinned shim
 *  that re-execs `claude` from PATH) dies in a handful of processes instead of
 *  fork-bombing the machine (2026-07-12: ~1800 runaway bun processes). */
export const WRAP_DEPTH_ENV = "TOKENMAXXING_WRAP_DEPTH";
export const MAX_WRAP_DEPTH = 5;
/** Stable fragment of the loop-abort diagnostic; verifyRealClaude greps a
 *  child's stderr for it to name the failure precisely. */
export const LOOP_DIAGNOSIS = "wrapper re-entered without reaching the real claude";

export function wrapDepth(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env[WRAP_DEPTH_ENV] ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Non-env backstop for the depth sentinel: an env-sanitizing shim in the loop
 *  (env -i / corporate launchers) strips the sentinel every cycle, so the
 *  wrapper ALSO counts its own entries in an on-disk sliding window that no
 *  child environment can erase. A self-spawn loop sustains several entries per
 *  second indefinitely; legitimate bursts (a tmux session restore launching
 *  dozens of panes) land once and go quiet, staying far under the cap. */
export const WRAP_RATE_MAX = 60;
export const WRAP_RATE_WINDOW_MS = 30_000;
const SpawnRateSchema = z.object({ entries: z.array(z.number()) });

export function wrapperEntryRateTripped(now: number): boolean {
  const file = join(paths.home, "spawnrate.json");
  let entries: number[] = [];
  try {
    entries = SpawnRateSchema.parse(JSON.parse(readFileSync(file, "utf8"))).entries;
  } catch { /* absent or corrupt - start a fresh window */ }
  entries = entries.filter((t) => now - t < WRAP_RATE_WINDOW_MS);
  entries.push(now);
  try {
    mkdirSync(paths.home, { recursive: true });
    writeFileAtomic(file, JSON.stringify({ entries }));
  } catch { /* an unwritable home must never block launching claude */ }
  return entries.length > WRAP_RATE_MAX;
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** True when `bin` IS tokenmaxxing (the `claude` wrapper, the `xx` alias, or the
 *  installed binary, via any symlink): spawning it as claude recurses through
 *  the supervisor. Realpath-based - a trailing slash, a symlinked dir, or a
 *  symlink to the wrapper must not defeat it the way the old exact-string
 *  binDir compare could. */
export function pointsBackAtUs(bin: string): boolean {
  const resolved = realpathOrNull(bin);
  const binDir = realpathOrNull(paths.binDir);
  return resolved != null && binDir != null && dirname(resolved) === binDir;
}

/** Every PATH `claude` that is not us, in PATH order, deduped by realpath.
 *  All of them, not just the first: a user-made wrapper script named claude can
 *  sit ahead of the real binary, and verified resolution must be able to walk
 *  past it. */
function scanPathForClaudeCandidates(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (!d) continue;
    const cand = join(d, "claude");
    try {
      if (existsSync(cand) && statSync(cand).isFile() && !pointsBackAtUs(cand)) {
        const key = realpathOrNull(cand) ?? cand;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(cand);
        }
      }
    } catch { /* ignore */ }
  }
  return out;
}

/** First PATH entry with a `claude` that is not us. null when PATH has none. */
export function scanPathForClaude(): string | null {
  return scanPathForClaudeCandidates()[0] ?? null;
}

export function resolveRealClaude(): string {
  const cfg = loadConfig();
  if (cfg.claudeBin) {
    // A configured-but-vanished binary must not silently degrade to the PATH
    // scan: under a relocated TOKENMAXXING_HOME the scan's binDir guard misses
    // the installed wrapper, which then recurses through the supervisor
    // (observed 2026-07-12 as a forever-hung `/usage` probe).
    if (!existsSync(cfg.claudeBin)) {
      throw new Error(`configured claudeBin does not exist: ${cfg.claudeBin} - fix config.json`);
    }
    // A pin that leads back to us is the recursion incident, not a claude.
    if (pointsBackAtUs(cfg.claudeBin)) {
      throw new Error(
        `configured claudeBin (${cfg.claudeBin}) is tokenmaxxing's own wrapper - spawning it recurses. Point claudeBin at the real claude binary in ${paths.configJson}`,
      );
    }
    return cfg.claudeBin;
  }
  const scanned = scanPathForClaude();
  if (scanned) return scanned;
  throw new Error("could not locate the real `claude` binary (set claudeBin in config.json)");
}

/** Behavioral check used by init/doctor before trusting a pin: the binary must
 *  answer `--version` without re-entering this wrapper. Depth is preset to the
 *  cap so an indirection back into us aborts on its FIRST wrapper entry instead
 *  of recursing. Returns null when the binary passes, else the failure detail. */
export function verifyRealClaude(bin: string): string | null {
  const env = { ...process.env, [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH), TOKENMAXXING_PROBE: "1" };
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    // spawnSync throws on an unrunnable path (ENOENT/EACCES) - that is a
    // verification failure to report, not a crash. SIGKILL: a TERM-trapping
    // candidate must not hang the very repair commands (init/doctor) that the
    // loop-abort diagnostic points the user at.
    p = Bun.spawnSync([bin, "--version"], { env, stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL" });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const outText = (p.stdout?.toString() ?? "").trim();
  const err = (p.stderr?.toString() ?? "").trim();
  if (p.exitCode === 0) {
    // exit 0 only proves something ran; the output must identify as claude
    // ("2.1.207 (Claude Code)" on 2.1.207) or the pin is some other program.
    if (/claude/i.test(outText)) return null;
    return `--version output does not identify claude: "${outText.slice(0, 80)}"`;
  }
  if (err.includes(LOOP_DIAGNOSIS)) return "it leads back into the tokenmaxxing wrapper (recursion)";
  return `--version exited ${p.exitCode ?? "on signal/timeout"}: ${(err || outText).slice(0, 160)}`;
}

/** Resolution for `init`'s pin: resolve, then behaviorally verify. A configured
 *  bin that fails verification (e.g. a shim pinned by an old version) falls back
 *  to the PATH scan, and the scan walks past failing candidates (a user-made
 *  claude wrapper ahead of the real binary) instead of giving up on the first. */
export function resolveVerifiedClaude(): string {
  const candidates: string[] = [];
  try {
    candidates.push(resolveRealClaude());
  } catch { /* broken config - the scan below is init's repair path */ }
  candidates.push(...scanPathForClaudeCandidates());

  const failures: string[] = [];
  for (const cand of uniq(candidates)) {
    const fail = verifyRealClaude(cand);
    if (fail === null) return cand;
    failures.push(`${cand}: ${fail}`);
  }
  if (failures.length > 0) throw new Error(`no usable claude binary found:\n  ${failures.join("\n  ")}`);
  throw new Error("could not locate the real `claude` binary (set claudeBin in config.json)");
}
