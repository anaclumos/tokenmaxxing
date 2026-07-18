// Config + accounts index + usage snapshot persistence. All writes atomic.

import { existsSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { isEqual } from "es-toolkit";
import { z } from "zod";
import { paths, realClaudeBinFromEnv, realCodexBinFromEnv } from "./paths.ts";
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
  // Screening bars, split per window (user 2026-07-16): a session reset is
  // cheap to sit out, weekly quota is use-it-or-lose-it so it drains to 98.
  thresholds: { session: 95, weekly: 98 },
  claudeBin: "",
  codexBin: "",
  // per-model weekly caps exist only for Sonnet and Fable (no Opus-only quota,
  // per the user 2026-07-12), and only Fable's is worth switching on.
  // greedySessionFloor 50: half a session window buys the swap (user 2026-07-16).
  policy: { projectionMargin: 0, greedySessionFloor: 50, switchModels: ["fable"], usagePollTtlMs: 90_000, maxWaitMs: 3_600_000 },
};

/** On-disk shape (all optional); validated via Zod, merged over defaults.
 *  Exported for `xx config`, which edits and housekeeps the sparse file. */
export const ConfigFileSchema = z
  .object({
    thresholds: z.object({ session: z.number(), weekly: z.number() }).partial(),
    claudeBin: z.string(),
    codexBin: z.string(),
    policy: z
      .object({
        projectionMargin: z.number(),
        greedySessionFloor: z.number(),
        switchModels: z.array(z.string()),
        usagePollTtlMs: z.number(),
        maxWaitMs: z.number(),
      })
      .partial(),
  })
  .partial();

export function loadConfig(): Config {
  const cfg: Config = { ...DEFAULT_CONFIG, thresholds: { ...DEFAULT_CONFIG.thresholds }, policy: { ...DEFAULT_CONFIG.policy } };
  if (existsSync(paths.configJson)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(paths.configJson, "utf8"));
    } catch {
      // Silent defaults here once meant a corrupt file could quietly unpin
      // claudeBin; a damaged config is the user's to repair, loudly.
      throw new Error(`${paths.configJson} is corrupt (unparsable JSON) - fix or remove it`);
    }
    const parsed = ConfigFileSchema.safeParse(raw);
    if (!parsed.success) {
      // Valid JSON with wrong-typed KNOWN keys must not silently drop pins
      // like claudeBin; unknown keys are stripped by the schema and stay
      // tolerated (that is `config tidy`'s territory, not an error).
      const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
      throw new Error(`${paths.configJson} has wrong-typed values (${fields}) - fix or remove them`);
    }
    const p = parsed.data;
    cfg.thresholds.session = p.thresholds?.session ?? cfg.thresholds.session;
    cfg.thresholds.weekly = p.thresholds?.weekly ?? cfg.thresholds.weekly;
    cfg.claudeBin = p.claudeBin ?? cfg.claudeBin;
    cfg.codexBin = p.codexBin ?? cfg.codexBin;
    cfg.policy.projectionMargin = p.policy?.projectionMargin ?? cfg.policy.projectionMargin;
    cfg.policy.greedySessionFloor = p.policy?.greedySessionFloor ?? cfg.policy.greedySessionFloor;
    cfg.policy.usagePollTtlMs = p.policy?.usagePollTtlMs ?? cfg.policy.usagePollTtlMs;
    cfg.policy.maxWaitMs = p.policy?.maxWaitMs ?? cfg.policy.maxWaitMs;
    if (p.policy?.switchModels) {
      cfg.policy.switchModels = p.policy.switchModels.map((s) => s.toLowerCase());
    }
  }
  // env overrides win for the real binaries (tests / relocation)
  const envBin = realClaudeBinFromEnv();
  if (envBin) cfg.claudeBin = envBin;
  const envCodexBin = realCodexBinFromEnv();
  if (envCodexBin) cfg.codexBin = envCodexBin;
  return ConfigSchema.parse(cfg);
}

export function saveConfig(c: Config): void {
  writeFileAtomic(paths.configJson, JSON.stringify(ConfigSchema.parse(c), null, 2) + "\n");
}

// ---- accounts.json -------------------------------------------------------

const emptyIndex = (): AccountsIndex => ({ version: 1, activeAccountUuid: null, accounts: [] });

export function loadAccounts(): AccountsIndex {
  // Absent = genuinely empty. Present-but-unreadable THROWS (mirrors the codex
  // state loaders): a truncated index once read as an empty pool would send
  // `init` down first-time onboarding and overwrite it, orphaning every parked
  // credential. Damaged state is the user's to repair, loudly.
  if (!existsSync(paths.accountsJson)) return emptyIndex();
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(paths.accountsJson, "utf8"));
  } catch {
    throw new Error(`${paths.accountsJson} is corrupt (unparsable JSON) - refusing to treat a damaged pool as empty; repair or remove the file`);
  }
  const parsed = AccountsIndexSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${paths.accountsJson} does not match the accounts schema - refusing to treat a damaged pool as empty; repair or remove the file`);
  }
  return parsed.data;
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
