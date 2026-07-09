// Resolve the REAL claude binary (never our shim on PATH).

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.ts";
import { loadConfig } from "./state.ts";

export function resolveRealClaude(): string {
  const cfg = loadConfig();
  if (cfg.claudeBin && existsSync(cfg.claudeBin)) return cfg.claudeBin;
  if (process.env.TOKENMAXXING_CLAUDE_BIN && existsSync(process.env.TOKENMAXXING_CLAUDE_BIN))
    return process.env.TOKENMAXXING_CLAUDE_BIN;
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (!d || d === paths.binDir) continue;
    const cand = join(d, "claude");
    try {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    } catch { /* ignore */ }
  }
  throw new Error("could not locate the real `claude` binary (set claudeBin in config.json)");
}
