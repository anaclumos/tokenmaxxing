import { closeSync, existsSync, fstatSync, openSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { isEqual, uniq } from "es-toolkit";
import { z } from "zod";
import { paths, realClaudeBinFromEnv, realCodexBinFromEnv } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import {
  AccountsIndexSchema,
  BankedResetProvidersSchema,
  ConfigSchema,
  LastSwapSchema,
  ModelUsageStateSchema,
  NextCheckSchema,
  SessionLadderSchema,
  UsageStateSchema,
  type AccountsIndex,
  type Config,
  type ModelUsageState,
  type UsageState,
  type WindowAnchor,
} from "./types.ts";

const DEFAULT_CONFIG: Config = {
  thresholds: { session: [90], weekly: 98 },
  hardThresholds: { session: 100, weekly: 100 },
  claudeBin: "",
  codexBin: "",
  policy: {
    projectionMargin: 0,
    greedySessionFloor: 80,
    greedySwapMargin: 0.15,
    switchModels: ["fable"],
    usagePollTtlMs: 90_000,
    maxWaitMs: 3_600_000,
    checkIntervalMs: 60_000,
    preferToUseBankedReset: [],
  },
};

const PercentSchema = z.number().min(0).max(100);

export const ConfigFileSchema = z
  .object({
    thresholds: z.object({ session: SessionLadderSchema, weekly: PercentSchema }).partial(),
    hardThresholds: z.object({ session: PercentSchema, weekly: PercentSchema }).partial(),
    claudeBin: z.string(),
    codexBin: z.string(),
    policy: z
      .object({
        projectionMargin: PercentSchema,
        greedySessionFloor: PercentSchema,
        greedySwapMargin: z.number().min(0).max(1),
        switchModels: z.array(z.string()),
        usagePollTtlMs: z.number().int().positive(),
        maxWaitMs: z.number().int().positive(),
        checkIntervalMs: z.number().int().min(10_000),
        preferToUseBankedReset: BankedResetProvidersSchema,
      })
      .partial(),
  })
  .partial();

const MergeOutcomeSchema = z.union([
  z.object({ ok: z.literal(true), config: ConfigSchema }),
  z.object({ ok: z.literal(false), detail: z.string() }),
]);
export type MergeOutcome = z.infer<typeof MergeOutcomeSchema>;

export function mergeConfigFile(p: z.infer<typeof ConfigFileSchema>): MergeOutcome {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    thresholds: { ...DEFAULT_CONFIG.thresholds },
    hardThresholds: { ...DEFAULT_CONFIG.hardThresholds },
    policy: { ...DEFAULT_CONFIG.policy },
  };
  cfg.thresholds.session = p.thresholds?.session ?? cfg.thresholds.session;
  cfg.thresholds.weekly = p.thresholds?.weekly ?? cfg.thresholds.weekly;
  cfg.hardThresholds.session = p.hardThresholds?.session ?? cfg.hardThresholds.session;
  cfg.hardThresholds.weekly = p.hardThresholds?.weekly ?? cfg.hardThresholds.weekly;
  cfg.claudeBin = p.claudeBin ?? cfg.claudeBin;
  cfg.codexBin = p.codexBin ?? cfg.codexBin;
  cfg.policy.projectionMargin = p.policy?.projectionMargin ?? cfg.policy.projectionMargin;
  cfg.policy.greedySessionFloor = p.policy?.greedySessionFloor ?? cfg.policy.greedySessionFloor;
  cfg.policy.greedySwapMargin = p.policy?.greedySwapMargin ?? cfg.policy.greedySwapMargin;
  cfg.policy.usagePollTtlMs = p.policy?.usagePollTtlMs ?? cfg.policy.usagePollTtlMs;
  cfg.policy.maxWaitMs = p.policy?.maxWaitMs ?? cfg.policy.maxWaitMs;
  cfg.policy.checkIntervalMs = p.policy?.checkIntervalMs ?? cfg.policy.checkIntervalMs;
  if (p.policy?.switchModels) {
    cfg.policy.switchModels = p.policy.switchModels.map((s) => s.toLowerCase());
  }
  if (p.policy?.preferToUseBankedReset) {
    cfg.policy.preferToUseBankedReset = uniq(p.policy.preferToUseBankedReset);
  }
  const envBin = realClaudeBinFromEnv();
  if (envBin) cfg.claudeBin = envBin;
  const envCodexBin = realCodexBinFromEnv();
  if (envCodexBin) cfg.codexBin = envCodexBin;
  const merged = ConfigSchema.safeParse(cfg);
  if (!merged.success) {
    return { ok: false, detail: merged.error.issues.map((issue) => issue.message).join("; ") };
  }
  return { ok: true, config: merged.data };
}

export function loadConfig(): Config {
  let fileData: z.infer<typeof ConfigFileSchema> = {};
  if (existsSync(paths.configJson)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(paths.configJson, "utf8"));
    } catch {
      throw new Error(`${paths.configJson} is corrupt (unparsable JSON) - fix or remove it`);
    }
    const parsed = ConfigFileSchema.safeParse(raw);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
      throw new Error(`${paths.configJson} has wrong-typed values (${fields}) - fix or remove them`);
    }
    fileData = parsed.data;
  }
  const outcome = mergeConfigFile(fileData);
  if (!outcome.ok) throw new Error(`${paths.configJson} is invalid: ${outcome.detail} - fix or remove the offending values`);
  return outcome.config;
}

export function pinBinOverride(input: { key: "claudeBin" | "codexBin"; bin: string }): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(paths.configJson)) {
    raw = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(paths.configJson, "utf8")));
  }
  raw[input.key] = input.bin;
  writeFileAtomic(paths.configJson, JSON.stringify(raw, null, 2) + "\n");
}

const emptyIndex = (): AccountsIndex => ({ version: 1, activeAccountUuid: null, accounts: [] });

export function loadAccounts(): AccountsIndex {
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

export function loadUsageSnapshot(): { state: UsageState; at: number } | null {
  let fd: number;
  try {
    fd = openSync(paths.usageJson, "r");
  } catch {
    return null;
  }
  try {
    const at = fstatSync(fd).mtimeMs;
    const parsed = UsageStateSchema.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    return parsed.success ? { state: parsed.data, at } : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function loadUsage(): UsageState | null {
  return loadUsageSnapshot()?.state ?? null;
}

export function clearUsageSnapshots(): void {
  rmSync(paths.usageJson, { force: true });
  rmSync(paths.modelUsageJson, { force: true });
}

export function loadLastSwapAt(): number | null {
  if (!existsSync(paths.lastSwapJson)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(paths.lastSwapJson, "utf8"));
  } catch {
    throw new Error(`${paths.lastSwapJson} is corrupt (unparsable JSON) - refusing to treat a damaged swap clock as never-swapped; repair or remove the file`);
  }
  return LastSwapSchema.parse(json).ts;
}

export function saveLastSwapAt(ts: number): void {
  writeFileAtomic(paths.lastSwapJson, JSON.stringify(LastSwapSchema.parse({ ts })));
}

export function loadLastResetAt(): number | null {
  if (!existsSync(paths.lastResetJson)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(paths.lastResetJson, "utf8"));
  } catch {
    throw new Error(`${paths.lastResetJson} is corrupt (unparsable JSON) - refusing to treat a damaged reset clock as never-reset; repair or remove the file`);
  }
  return LastSwapSchema.parse(json).ts;
}

export function saveLastResetAt(ts: number): void {
  writeFileAtomic(paths.lastResetJson, JSON.stringify(LastSwapSchema.parse({ ts })));
}

export function loadLastSeatChangeAt(): number | null {
  const swapAt = loadLastSwapAt();
  const resetAt = loadLastResetAt();
  if (swapAt == null) return resetAt;
  if (resetAt == null) return swapAt;
  return Math.max(swapAt, resetAt);
}

const DepletedWaitSchema = z.object({ waitUntil: z.number(), accountUuid: z.string(), ts: z.number() });
export type DepletedWait = z.infer<typeof DepletedWaitSchema>;

export function loadDepletedWait(): DepletedWait | null {
  if (!existsSync(paths.depletedJson)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(paths.depletedJson, "utf8"));
  } catch {
    throw new Error(`${paths.depletedJson} is corrupt (unparsable JSON) - repair or remove the file`);
  }
  return DepletedWaitSchema.parse(json);
}

export function saveDepletedWait(rec: DepletedWait): void {
  writeFileAtomic(paths.depletedJson, JSON.stringify(DepletedWaitSchema.parse(rec)));
}

export function clearDepletedWait(): void {
  rmSync(paths.depletedJson, { force: true });
}

export const MAX_CHECK_DELAY_TICKS = 5;
export const POST_SWAP_COOLDOWN_MS = 45_000;

export function maxCheckDelayMs(cfg: Config): number {
  return MAX_CHECK_DELAY_TICKS * cfg.policy.checkIntervalMs;
}

export function loadNextCheckDueAt(input: { now: number; cfg: Config }): number | null {
  if (!existsSync(paths.nextCheckJson)) return null;
  let parsed;
  try {
    parsed = NextCheckSchema.safeParse(JSON.parse(readFileSync(paths.nextCheckJson, "utf8")));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  return parsed.data.dueAt - input.now > Math.max(maxCheckDelayMs(input.cfg), POST_SWAP_COOLDOWN_MS) ? null : parsed.data.dueAt;
}

export function saveNextCheckDueAt(input: { dueAt: number; ts: number }): void {
  writeFileAtomic(paths.nextCheckJson, JSON.stringify(NextCheckSchema.parse(input)));
}

export function clearNextCheck(): void {
  rmSync(paths.nextCheckJson, { force: true });
}

const USAGE_TS_REFRESH_MS = 10 * 60_000;
const SESSION_COST_MIN_DELTA = 25;

function anchorHolds(anchor: WindowAnchor, next: UsageState): boolean {
  return (
    anchor.fiveHourResetsAt === next.fiveHour.resetsAt &&
    anchor.sevenDayResetsAt === next.sevenDay.resetsAt &&
    next.fiveHour.usedPercentage >= anchor.session &&
    next.sevenDay.usedPercentage >= anchor.weekly
  );
}

export function measureSessionWindow(prev: UsageState | null, next: UsageState, stamp: boolean): Pick<UsageState, "anchor" | "sessionWindowWeeklyCost"> {
  const same = prev != null && prev.account === next.account;
  const carried = same ? prev.sessionWindowWeeklyCost : undefined;
  if (stamp) return { ...(same && prev.anchor ? { anchor: prev.anchor } : {}), ...(carried != null ? { sessionWindowWeeklyCost: carried } : {}) };
  const anchor: WindowAnchor =
    same && prev.anchor && anchorHolds(prev.anchor, next)
      ? prev.anchor
      : { fiveHourResetsAt: next.fiveHour.resetsAt, sevenDayResetsAt: next.sevenDay.resetsAt, session: next.fiveHour.usedPercentage, weekly: next.sevenDay.usedPercentage };
  const sessionDelta = next.fiveHour.usedPercentage - anchor.session;
  const weeklyDelta = next.sevenDay.usedPercentage - anchor.weekly;
  const measured = sessionDelta >= SESSION_COST_MIN_DELTA && weeklyDelta > 0 ? (100 * weeklyDelta) / sessionDelta : undefined;
  const cost = measured ?? carried;
  return { anchor, ...(cost != null ? { sessionWindowWeeklyCost: cost } : {}) };
}

export function writeUsage(input: UsageState, opts: { stamp?: boolean } = {}): boolean {
  const prev = loadUsage();
  const next: UsageState = { ...input, ...measureSessionWindow(prev, input, opts.stamp === true) };
  if (prev && isEqual({ ...prev, ts: 0 }, { ...next, ts: 0 }) && next.ts - prev.ts < USAGE_TS_REFRESH_MS) {
    try {
      utimesSync(paths.usageJson, new Date(next.ts), new Date(next.ts));
    } catch (e) {
      const errno = z.object({ code: z.string() }).safeParse(e);
      if (!errno.success || errno.data.code !== "ENOENT") throw e;
    }
    return false;
  }
  writeFileAtomic(paths.usageJson, JSON.stringify(next));
  return true;
}

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
