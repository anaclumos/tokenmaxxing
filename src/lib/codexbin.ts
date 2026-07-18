// Resolve the REAL codex binary (never our shim on PATH). Same guarantees as
// claudebin.ts: a configured-but-missing pin fails fast instead of degrading
// to a scan, and anything that realpath-resolves into our binDir is refused
// (spawning it as codex would recurse through the codex supervisor).

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, WRAP_DEPTH_ENV, pointsBackAtUs } from "./claudebin.ts";
import { loadConfig } from "./state.ts";
import { paths } from "./paths.ts";

/** First PATH entry with a `codex` that is not us. null when PATH has none. */
function scanPathForCodex(): string | null {
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (!d) continue;
    const cand = join(d, "codex");
    try {
      if (existsSync(cand) && statSync(cand).isFile() && !pointsBackAtUs(cand)) return cand;
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveRealCodex(): string {
  const cfg = loadConfig();
  if (cfg.codexBin) {
    if (!existsSync(cfg.codexBin)) {
      throw new Error(`configured codexBin does not exist: ${cfg.codexBin} - fix config.json`);
    }
    if (pointsBackAtUs(cfg.codexBin)) {
      throw new Error(
        `configured codexBin (${cfg.codexBin}) is tokenmaxxing's own wrapper - spawning it recurses. Point codexBin at the real codex binary in ${paths.configJson}`,
      );
    }
    return cfg.codexBin;
  }
  const scanned = scanPathForCodex();
  if (scanned) return scanned;
  throw new Error("could not locate the real `codex` binary (set codexBin in config.json)");
}

/** Behavioral check used by `init --codex` before pinning: the binary must
 *  answer `--version` identifying itself as codex, without re-entering our
 *  wrapper (depth preset to the cap kills a poisoned pin on first entry).
 *  Returns null when the binary passes, else the failure detail. */
export function verifyRealCodex(input: { bin: string }): string | null {
  const env = { ...process.env, [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH), TOKENMAXXING_PROBE: "1" };
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync([input.bin, "--version"], { env, stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL" });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const outText = (p.stdout?.toString() ?? "").trim();
  const err = (p.stderr?.toString() ?? "").trim();
  if (p.exitCode === 0) {
    if (outText.toLowerCase().includes("codex")) return null;
    return `--version output does not identify codex: "${outText.slice(0, 80)}"`;
  }
  if (err.includes(LOOP_DIAGNOSIS)) return "it leads back into the tokenmaxxing wrapper (recursion)";
  return `--version exited ${p.exitCode ?? "on signal/timeout"}: ${(err || outText).slice(0, 160)}`;
}
