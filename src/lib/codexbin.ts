import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOOP_DIAGNOSIS, MAX_WRAP_DEPTH, WRAP_DEPTH_ENV, pointsBackAtUs } from "./claudebin.ts";
import { loadConfig } from "./state.ts";
import { paths } from "./paths.ts";

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
