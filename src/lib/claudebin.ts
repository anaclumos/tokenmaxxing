// Resolve the REAL claude binary (never our shim on PATH).

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.ts";
import { loadConfig } from "./state.ts";

export function resolveRealClaude(): string {
  const cfg = loadConfig();
  if (cfg.claudeBin) {
    if (existsSync(cfg.claudeBin)) return cfg.claudeBin;
    // A configured-but-vanished binary must not silently degrade to the PATH
    // scan: under a relocated TOKENMAXXING_HOME the scan's binDir guard misses
    // the installed wrapper, which then recurses through the supervisor
    // (observed 2026-07-12 as a forever-hung `/usage` probe).
    throw new Error(`configured claudeBin does not exist: ${cfg.claudeBin} - fix config.json`);
  }
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (!d || d === paths.binDir) continue;
    const cand = join(d, "claude");
    try {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    } catch { /* ignore */ }
  }
  throw new Error("could not locate the real `claude` binary (set claudeBin in config.json)");
}
