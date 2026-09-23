import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { uniq } from "es-toolkit";
import { z } from "zod";
import { errorMessage } from "./log.ts";
import { paths } from "./paths.ts";
import { loadConfig, type BinKey } from "./state.ts";
import { writeFileAtomic } from "./atomic.ts";

export const WRAP_DEPTH_ENV = "TOKENMAXXING_WRAP_DEPTH";
export const MAX_WRAP_DEPTH = 5;
export const UNMANAGED_ENV = "TOKENMAXXING_UNMANAGED";
export const LOOP_DIAGNOSIS = "wrapper re-entered without reaching the real";

export function wrapDepth(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env[WRAP_DEPTH_ENV] ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export const WRAP_RATE_MAX = 60;
export const WRAP_RATE_WINDOW_MS = 30_000;
const SpawnRateSchema = z.object({ entries: z.array(z.number()) });

export function wrapperEntryRateTripped(now: number): boolean {
  const file = join(paths.home, "spawnrate.json");
  let entries: number[] = [];
  try {
    entries = SpawnRateSchema.parse(JSON.parse(readFileSync(file, "utf8"))).entries;
  } catch {  }
  entries = entries.filter((t) => now - t < WRAP_RATE_WINDOW_MS);
  entries.push(now);
  try {
    mkdirSync(paths.home, { recursive: true });
    writeFileAtomic(file, JSON.stringify({ entries }));
  } catch {  }
  return entries.length > WRAP_RATE_MAX;
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export function pointsBackAtUs(bin: string): boolean {
  const resolved = realpathOrNull(bin);
  const binDir = realpathOrNull(paths.binDir);
  return resolved != null && binDir != null && dirname(resolved) === binDir;
}

function scanPathCandidates(name: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (!d) continue;
    const cand = join(d, name);
    if (!existsSync(cand) || !statSync(cand).isFile() || pointsBackAtUs(cand)) continue;
    const key = realpathOrNull(cand) ?? cand;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cand);
  }
  return out;
}

export function resolveRealBin(input: { name: string; key: BinKey }): string {
  const configured = loadConfig()[input.key];
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`configured ${input.key} does not exist: ${configured} - fix config.json`);
    }
    if (pointsBackAtUs(configured)) {
      throw new Error(
        `configured ${input.key} (${configured}) is tokenmaxxing's own wrapper - spawning it recurses. Point ${input.key} at the real ${input.name} binary in ${paths.configJson}`,
      );
    }
    return configured;
  }
  const scanned = scanPathCandidates(input.name)[0];
  if (scanned) return scanned;
  throw new Error(`could not locate the real \`${input.name}\` binary (set ${input.key} in config.json)`);
}

export function verifyRealBin(input: { bin: string; name: string; versionOk: (versionOutput: string) => boolean }): string | null {
  const env = { ...process.env, [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH), TOKENMAXXING_PROBE: "1" };
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync([input.bin, "--version"], { env, stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL" });
  } catch (e) {
    return errorMessage(e);
  }
  const outText = (p.stdout?.toString() ?? "").trim();
  const err = (p.stderr?.toString() ?? "").trim();
  if (p.exitCode === 0) {
    if (input.versionOk(outText)) return null;
    return `--version output does not identify ${input.name}: "${outText.slice(0, 80)}"`;
  }
  if (err.includes(LOOP_DIAGNOSIS)) return "it leads back into the tokenmaxxing wrapper (recursion)";
  return `--version exited ${p.exitCode ?? "on signal/timeout"}: ${(err || outText).slice(0, 160)}`;
}

export const CLAUDE_BIN = { name: "claude", key: "claudeBin", versionOk: (out: string) => out.toLowerCase().includes("claude") } as const;
export const CODEX_BIN = { name: "codex", key: "codexBin", versionOk: (out: string) => out.toLowerCase().includes("codex") } as const;

export function resolveVerifiedClaude(): string {
  const candidates: string[] = [];
  try {
    candidates.push(resolveRealBin(CLAUDE_BIN));
  } catch {  }
  candidates.push(...scanPathCandidates(CLAUDE_BIN.name));

  const failures: string[] = [];
  for (const cand of uniq(candidates)) {
    const fail = verifyRealBin({ ...CLAUDE_BIN, bin: cand });
    if (fail === null) return cand;
    failures.push(`${cand}: ${fail}`);
  }
  if (failures.length > 0) throw new Error(`no usable claude binary found:\n  ${failures.join("\n  ")}`);
  throw new Error("could not locate the real `claude` binary (set claudeBin in config.json)");
}
