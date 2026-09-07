import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { uniq } from "es-toolkit";
import { z } from "zod";
import { paths } from "./paths.ts";
import { loadConfig } from "./state.ts";
import { writeFileAtomic } from "./atomic.ts";
import { errorMessage } from "./errors.ts";
import { readJson } from "./json.ts";

export const WRAP_DEPTH_ENV = "TOKENMAXXING_WRAP_DEPTH";
export const MAX_WRAP_DEPTH = 5;
export const UNMANAGED_ENV = "TOKENMAXXING_UNMANAGED";
export const LOOP_DIAGNOSIS = "wrapper re-entered without reaching the real claude";

const WrapDepthSchema = z.coerce.number().int().nonnegative().optional();

export function wrapDepth(env: Record<string, string | undefined> = process.env): number {
  return WrapDepthSchema.parse(env[WRAP_DEPTH_ENV]) ?? 0;
}

export const WRAP_RATE_MAX = 60;
export const WRAP_RATE_WINDOW_MS = 30_000;
const SpawnRateSchema = z.object({ entries: z.array(z.number()) });

export function wrapperEntryRateTripped(now: number): boolean {
  const file = join(paths.home, "spawnrate.json");
  const entries = (readJson(file, SpawnRateSchema)?.entries ?? []).filter((t) => now - t < WRAP_RATE_WINDOW_MS);
  entries.push(now);
  writeFileAtomic(file, JSON.stringify({ entries }));
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

type BinName = "claude" | "codex";

function scanPathForCandidates(name: BinName): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const cand = Bun.which(name, { PATH: dir });
    if (cand == null || pointsBackAtUs(cand)) continue;
    const key = realpathOrNull(cand) ?? cand;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cand);
  }
  return out;
}

export function resolveRealBin(input: { name: BinName }): string {
  const key = input.name === "claude" ? "claudeBin" : "codexBin";
  const configured = loadConfig()[key];
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`configured ${key} does not exist: ${configured} - fix config.json`);
    }
    if (pointsBackAtUs(configured)) {
      throw new Error(
        `configured ${key} (${configured}) is tokenmaxxing's own wrapper - spawning it recurses. Point ${key} at the real ${input.name} binary in ${paths.configJson}`,
      );
    }
    return configured;
  }
  const scanned = scanPathForCandidates(input.name)[0];
  if (scanned) return scanned;
  throw new Error(`could not locate the real \`${input.name}\` binary (set ${key} in config.json)`);
}

export function resolveRealClaude(): string {
  return resolveRealBin({ name: "claude" });
}

export function resolveRealCodex(): string {
  return resolveRealBin({ name: "codex" });
}

export function verifyRealBin(input: { name: BinName; bin: string }): string | null {
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
    if (outText.toLowerCase().includes(input.name)) return null;
    return `--version output does not identify ${input.name}: "${outText.slice(0, 80)}"`;
  }
  if (err.includes(LOOP_DIAGNOSIS)) return "it leads back into the tokenmaxxing wrapper (recursion)";
  return `--version exited ${p.exitCode ?? "on signal/timeout"}: ${(err || outText).slice(0, 160)}`;
}

export function resolveVerifiedClaude(): string {
  const candidates: string[] = [];
  try {
    candidates.push(resolveRealClaude());
  } catch {  }
  candidates.push(...scanPathForCandidates("claude"));

  const failures: string[] = [];
  for (const cand of uniq(candidates)) {
    const fail = verifyRealBin({ name: "claude", bin: cand });
    if (fail === null) return cand;
    failures.push(`${cand}: ${fail}`);
  }
  if (failures.length > 0) throw new Error(`no usable claude binary found:\n  ${failures.join("\n  ")}`);
  throw new Error("could not locate the real `claude` binary (set claudeBin in config.json)");
}
