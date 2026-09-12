import { closeSync, existsSync, fstatSync, openSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { isEqual } from "es-toolkit";
import { z } from "zod";
import { paths, realClaudeBinFromEnv, realCodexBinFromEnv, type PoolPaths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import {
  AccountsIndexSchema,
  ConfigSchema,
  ErrnoSchema,
  LastSwapSchema,
  UsageStateSchema,
  type Account,
  type AccountsIndex,
  type Config,
  type UsageState,
  type Window,
} from "./types.ts";

export function loadConfig(): Config {
  let raw: unknown = {};
  if (existsSync(paths.configJson)) {
    try {
      raw = JSON.parse(readFileSync(paths.configJson, "utf8"));
    } catch {
      throw new Error(`${paths.configJson} is corrupt (unparsable JSON) - fix or remove it`);
    }
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ");
    throw new Error(`${paths.configJson} is invalid (${fields}) - fix or remove the offending values`);
  }
  const cfg = parsed.data;
  const envBin = realClaudeBinFromEnv();
  if (envBin) cfg.claudeBin = envBin;
  const envCodexBin = realCodexBinFromEnv();
  if (envCodexBin) cfg.codexBin = envCodexBin;
  return cfg;
}

export function pinBinOverride(input: { key: "claudeBin" | "codexBin"; bin: string }): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(paths.configJson)) {
    raw = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(paths.configJson, "utf8")));
  }
  raw[input.key] = input.bin;
  writeFileAtomic(paths.configJson, JSON.stringify(raw, null, 2) + "\n");
}

const emptyIndex = (): AccountsIndex => ({ version: 2, activeId: null, accounts: [] });

export function loadAccounts(pool: PoolPaths): AccountsIndex {
  if (!existsSync(pool.accountsJson)) return emptyIndex();
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(pool.accountsJson, "utf8"));
  } catch {
    throw new Error(`${pool.accountsJson} is corrupt (unparsable JSON) - refusing to treat a damaged pool as empty; repair or remove the file`);
  }
  const parsed = AccountsIndexSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${pool.accountsJson} does not match the accounts schema - refusing to treat a damaged pool as empty; repair or remove the file`);
  }
  return parsed.data;
}

export function saveAccounts(pool: PoolPaths, idx: AccountsIndex): void {
  writeFileAtomic(pool.accountsJson, JSON.stringify(AccountsIndexSchema.parse(idx), null, 2) + "\n");
}

export type Harvest = {
  id: string;
  email: string | null;
  tier: string | null;
  oauthAccount?: Account["oauthAccount"];
  sample: { windows: Window[]; at: number } | null;
  park: () => Promise<void>;
};

export function upsertAccount(
  idx: AccountsIndex,
  h: Harvest,
  mergeWindows: (next: Window[], prev: Window[]) => Window[],
): Account {
  const existing = idx.accounts.find((a) => a.id === h.id);
  const fresh: Account = {
    id: h.id,
    label: existing?.label ?? h.email ?? h.id.slice(0, 8),
    email: h.email,
    tier: h.tier,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    windows: h.sample ? mergeWindows(h.sample.windows, existing?.windows ?? []) : (existing?.windows ?? []),
    lastUsageAt: h.sample ? h.sample.at : existing?.lastUsageAt,
    needsReauth: false,
    ...(h.oauthAccount ? { oauthAccount: h.oauthAccount } : {}),
  };
  if (existing) Object.assign(existing, fresh);
  else idx.accounts.push(fresh);
  return existing ?? fresh;
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
}

export function loadLastSwapAt(pool: PoolPaths): number | null {
  if (!existsSync(pool.lastSwapJson)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(pool.lastSwapJson, "utf8"));
  } catch {
    throw new Error(`${pool.lastSwapJson} is corrupt (unparsable JSON) - refusing to treat a damaged swap clock as never-swapped; repair or remove the file`);
  }
  return LastSwapSchema.parse(json).ts;
}

export function saveLastSwapAt(pool: PoolPaths, ts: number): void {
  writeFileAtomic(pool.lastSwapJson, JSON.stringify(LastSwapSchema.parse({ ts })));
}

const DepletedWaitSchema = z.object({ waitUntil: z.number(), id: z.string(), ts: z.number() });
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

export const POST_SWAP_COOLDOWN_MS = 45_000;

const USAGE_TS_REFRESH_MS = 10 * 60_000;
const SAMPLED_AT_REFRESH_MS = 30_000;

export function writeUsage(input: UsageState, opts: { stamp?: boolean } = {}): boolean {
  const prev = loadUsage();
  const stamp = opts.stamp === true;
  const carriedSampleAt = prev != null && prev.account === input.account ? (prev.sampledAt ?? prev.ts) : undefined;
  const sampledAt = stamp ? (carriedSampleAt ?? input.sampledAt) : input.ts;
  const next: UsageState = { ...input, ...(sampledAt != null ? { sampledAt } : {}) };
  if (
    prev &&
    isEqual({ ...prev, ts: 0, sampledAt: 0 }, { ...next, ts: 0, sampledAt: 0 }) &&
    next.ts - prev.ts < USAGE_TS_REFRESH_MS &&
    (stamp || next.ts - (prev.sampledAt ?? prev.ts) < SAMPLED_AT_REFRESH_MS)
  ) {
    try {
      utimesSync(paths.usageJson, new Date(next.ts), new Date(next.ts));
    } catch (e) {
      if (ErrnoSchema.safeParse(e).data?.code !== "ENOENT") throw e;
    }
    return false;
  }
  writeFileAtomic(paths.usageJson, JSON.stringify(next));
  return true;
}
