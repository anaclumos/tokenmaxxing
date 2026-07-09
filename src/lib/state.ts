// Config + accounts index + usage snapshot persistence. All writes atomic.

import { existsSync, readFileSync } from "node:fs";
import { isEqual } from "es-toolkit";
import { z } from "zod";
import { paths, realClaudeBinFromEnv } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import {
  AccountsIndexSchema,
  ConfigSchema,
  ModelUsageStateSchema,
  UsageStateSchema,
  type AccountsIndex,
  type Config,
  type ModelUsageState,
  type UsageState,
} from "./types.ts";

// ---- config.json (minimal, fixed schema) ---------------------------------

const DEFAULT_CONFIG: Config = {
  threshold: 95,
  claudeBin: "",
  policy: { projectionMargin: 0, switchModels: ["fable", "opus"], usagePollTtlMs: 90_000, maxWaitMs: 3_600_000 },
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

/** Write-on-change: skip the write (and its fsync) when only `ts` would differ. */
export function writeUsage(next: UsageState): boolean {
  const prev = loadUsage();
  if (prev && isEqual({ ...prev, ts: 0 }, { ...next, ts: 0 })) return false;
  writeFileAtomic(paths.usageJson, JSON.stringify(next));
  return true;
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
