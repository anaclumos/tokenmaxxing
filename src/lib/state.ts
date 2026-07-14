// Config + accounts index + usage snapshot persistence. All writes atomic.

import { existsSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { isEqual } from "es-toolkit";
import { z } from "zod";
import { paths, realClaudeBinFromEnv } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import {
  AccountsIndexSchema,
  ConfigSchema,
  LastSwapSchema,
  ModelUsageStateSchema,
  UsageStateSchema,
  type AccountsIndex,
  type Config,
  type ModelUsageState,
  type UsageState,
} from "./types.ts";

// ---- config.json (minimal, fixed schema) ---------------------------------

const DEFAULT_CONFIG: Config = {
  threshold: 98,
  claudeBin: "",
  // per-model weekly caps exist only for Sonnet and Fable (no Opus-only quota,
  // per the user 2026-07-12), and only Fable's is worth switching on.
  policy: { projectionMargin: 0, switchModels: ["fable"], usagePollTtlMs: 90_000, maxWaitMs: 3_600_000 },
};

/** On-disk shape (all optional); validated via Zod, merged over defaults. */
const ConfigFileSchema = z
  .object({
    threshold: z.number(),
    claudeBin: z.string(),
    policy: z
      .object({
        projectionMargin: z.number(),
        switchModels: z.array(z.string()),
        usagePollTtlMs: z.number(),
        maxWaitMs: z.number(),
      })
      .partial(),
  })
  .partial();

export function loadConfig(): Config {
  const cfg: Config = { ...DEFAULT_CONFIG, policy: { ...DEFAULT_CONFIG.policy } };
  if (existsSync(paths.configJson)) {
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(paths.configJson, "utf8"));
    } catch {
      raw = {};
    }
    const parsed = ConfigFileSchema.safeParse(raw);
    const p = parsed.success ? parsed.data : {};
    cfg.threshold = p.threshold ?? cfg.threshold;
    cfg.claudeBin = p.claudeBin ?? cfg.claudeBin;
    cfg.policy.projectionMargin = p.policy?.projectionMargin ?? cfg.policy.projectionMargin;
    cfg.policy.usagePollTtlMs = p.policy?.usagePollTtlMs ?? cfg.policy.usagePollTtlMs;
    cfg.policy.maxWaitMs = p.policy?.maxWaitMs ?? cfg.policy.maxWaitMs;
    if (p.policy?.switchModels) {
      cfg.policy.switchModels = p.policy.switchModels.map((s) => s.toLowerCase());
    }
  }
  // env override wins for the claude binary (tests / relocation)
  const envBin = realClaudeBinFromEnv();
  if (envBin) cfg.claudeBin = envBin;
  return ConfigSchema.parse(cfg);
}

export function saveConfig(c: Config): void {
  writeFileAtomic(paths.configJson, JSON.stringify(ConfigSchema.parse(c), null, 2) + "\n");
}

// ---- accounts.json -------------------------------------------------------

const emptyIndex = (): AccountsIndex => ({ version: 1, activeAccountUuid: null, accounts: [] });

export function loadAccounts(): AccountsIndex {
  if (!existsSync(paths.accountsJson)) return emptyIndex();
  try {
    const parsed = AccountsIndexSchema.safeParse(JSON.parse(readFileSync(paths.accountsJson, "utf8")));
    return parsed.success ? parsed.data : emptyIndex();
  } catch {
    return emptyIndex();
  }
}

export function saveAccounts(idx: AccountsIndex): void {
  writeFileAtomic(paths.accountsJson, JSON.stringify(AccountsIndexSchema.parse(idx), null, 2) + "\n");
}

// ---- usage.json ----------------------------------------------------------

export function loadUsage(): UsageState | null {
  if (!existsSync(paths.usageJson)) return null;
  try {
    const parsed = UsageStateSchema.safeParse(JSON.parse(readFileSync(paths.usageJson, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Drop the statusLine-fed snapshots after a swap: their windows belong to the
 *  pre-swap account and would otherwise be read under the new active org. */
export function clearUsageSnapshots(): void {
  rmSync(paths.usageJson, { force: true });
  rmSync(paths.modelUsageJson, { force: true });
}

// ---- lastswap.json (epoch ms of the last swap; absent = never swapped) ----

export function loadLastSwapAt(): number | null {
  if (!existsSync(paths.lastSwapJson)) return null;
  try {
    const parsed = LastSwapSchema.safeParse(JSON.parse(readFileSync(paths.lastSwapJson, "utf8")));
    return parsed.success ? parsed.data.ts : null;
  } catch {
    return null;
  }
}

export function saveLastSwapAt(ts: number): void {
  writeFileAtomic(paths.lastSwapJson, JSON.stringify(LastSwapSchema.parse({ ts })));
}

/** An alive feed re-proving unchanged figures still refreshes `ts` this often,
 *  so cache-age displays stay honest without a write+fsync per tick. */
const USAGE_TS_REFRESH_MS = 10 * 60_000;

/** Write-on-change: skip the write (and its fsync) when only `ts` would differ,
 *  unless the stored `ts` has aged past the refresh window. A suppressed write
 *  still bumps the file's mtime (metadata only, no fsync): mtime is the feed's
 *  liveness heartbeat, and without the bump an alive tee re-proving unchanged
 *  figures reads as a dead feed and the decision path goes model-blind. */
export function writeUsage(next: UsageState): boolean {
  const prev = loadUsage();
  if (prev && isEqual({ ...prev, ts: 0 }, { ...next, ts: 0 }) && next.ts - prev.ts < USAGE_TS_REFRESH_MS) {
    try {
      utimesSync(paths.usageJson, new Date(next.ts), new Date(next.ts));
    } catch (e) {
      // The file vanished mid-race: a concurrent swap just invalidated these
      // figures. Suppressing stays correct; a write would resurrect them.
      if ((e as { code?: string }).code !== "ENOENT") throw e;
    }
    return false;
  }
  writeFileAtomic(paths.usageJson, JSON.stringify(next));
  return true;
}

/** When the usage feed last proved itself alive (usage.json mtime), null if the
 *  snapshot is absent. Fresher than the embedded `ts`, which write-on-change
 *  deliberately lets age while figures hold still. */
export function usageTeeAt(): number | null {
  try {
    return statSync(paths.usageJson).mtimeMs;
  } catch {
    return null;
  }
}

// ---- model-usage.json (per-model caps from `/usage`, TTL-cached) ----------

export function loadModelUsage(): ModelUsageState | null {
  if (!existsSync(paths.modelUsageJson)) return null;
  try {
    const parsed = ModelUsageStateSchema.safeParse(JSON.parse(readFileSync(paths.modelUsageJson, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveModelUsage(next: ModelUsageState): void {
  writeFileAtomic(paths.modelUsageJson, JSON.stringify(next));
}
