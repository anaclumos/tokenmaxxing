// Usage data from two sources: statusLine stdin (pushed every turn, aggregate
// windows only, epoch resets) and `claude -p '/usage'` (free, 0 tokens, all
// three limit kinds). `/usage` is a client-side command that renders the same
// figures claude's own usage screen shows; we run it in a throwaway
// CLAUDE_CONFIG_DIR to sample a parked account without disturbing the live login.

import { delay } from "es-toolkit";
import { z } from "zod";
import { resolveRealClaude } from "./claudebin.ts";
import { log } from "./log.ts";
import { RateLimitsStdinSchema, UsageWindowSchema, type ModelInfo, type UsageWindow, type UsageWindows } from "./types.ts";

/** Normalize a resets_at value (epoch s, epoch ms, or ISO string) to epoch ms. */
export function normalizeResetsAt(v: unknown): number | null {
  const num = z.number().finite().safeParse(v);
  if (num.success) {
    return num.data < 1e12 ? Math.round(num.data * 1000) : Math.round(num.data);
  }
  const str = z.string().safeParse(v);
  if (str.success && str.data.trim() !== "") {
    const n = Number(str.data);
    if (Number.isFinite(n)) return normalizeResetsAt(n);
    const t = Date.parse(str.data);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

const win = (w?: { used_percentage: number; resets_at?: number | null }): UsageWindow => ({
  usedPercentage: w?.used_percentage ?? 0,
  resetsAt: normalizeResetsAt(w?.resets_at),
});

/** Extract the two AGGREGATE windows from statusLine stdin. null if absent. */
export function parseStatusLineStdin(obj: unknown): UsageWindows | null {
  const parsed = RateLimitsStdinSchema.safeParse(obj);
  if (!parsed.success) return null;
  const rl = parsed.data.rate_limits;
  if (!rl || (!rl.five_hour && !rl.seven_day)) return null;
  return { fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day) };
}

/** Extract the active model from statusLine stdin. null if absent. */
export function parseStatusLineModel(obj: unknown): ModelInfo | null {
  const parsed = RateLimitsStdinSchema.safeParse(obj);
  if (!parsed.success) return null;
  const m = parsed.data.model;
  if (!m?.id && !m?.display_name) return null;
  return { id: m?.id ?? m?.display_name ?? "", display: m?.display_name ?? m?.id ?? "" };
}

export const FullUsageSchema = z.object({
  session: UsageWindowSchema,
  weekAll: UsageWindowSchema,
  perModel: z.record(z.string(), UsageWindowSchema),
});
export type FullUsage = z.infer<typeof FullUsageSchema>;

// ---- `/usage` text parsing -----------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** The tz offset (wall-clock minus UTC, in ms) in `tz` at instant `utcMs`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const p: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") p[part.type] = Number(part.value);
  const asUTC = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUTC - utcMs;
}

/** Interpret a wall-clock time in `tz` as an epoch (DST-correct via one refine). */
function zonedWallToEpoch(y: number, mon: number, day: number, hour: number, min: number, tz: string): number {
  const guess = Date.UTC(y, mon, day, hour, min);
  const off1 = tzOffsetMs(guess, tz);
  const off2 = tzOffsetMs(guess - off1, tz);
  return guess - off2;
}

/**
 * Parse a `/usage` reset clock like `Jul 11 at 12pm (Asia/Seoul)` or
 * `Jul 9 at 11:20pm (Asia/Seoul)` to epoch ms. The text carries no year, so we
 * pick the year whose resulting instant is nearest `now` (resets are always days
 * away, so the correct year wins by ~360 days). Returns null if unparseable.
 */
export function parseResetClock(clock: string, now = Date.now()): number | null {
  const m = clock.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap])m\s*\(([^)]+)\)/i);
  if (!m) return null;
  const mon = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  if (mon === undefined) return null;
  const day = Number(m[2]);
  let hour = Number(m[3]) % 12;
  if (m[5]!.toLowerCase() === "p") hour += 12;
  const min = m[4] ? Number(m[4]) : 0;
  const tz = m[6]!.trim();

  const baseYear = new Date(now).getUTCFullYear();
  let best: number | null = null;
  for (const y of [baseYear - 1, baseYear, baseYear + 1]) {
    let epoch: number;
    try {
      epoch = zonedWallToEpoch(y, mon, day, hour, min, tz);
    } catch {
      return null; // invalid tz
    }
    if (best === null || Math.abs(epoch - now) < Math.abs(best - now)) best = epoch;
  }
  return best;
}

/**
 * Parse `claude -p '/usage'` .result text into all three limit kinds:
 *   Current session: N% used · resets <clock>      → session (5h)
 *   Current week (all models): N% used · resets …   → weekAll (7d aggregate)
 *   Current week (<Model>): N% used · resets …      → perModel[<Model>]
 */
export function parseUsageTextFull(text: string, now = Date.now()): FullUsage | null {
  if (!text) return null;
  // The reset clock is required in full (month day at h[:mm]am/pm (tz)) inside its
  // optional group, so the lazy bridge is forced to find it when present yet the
  // group cleanly skips a line that has no clock - and it never swallows a
  // following "Current …" entry on a single line.
  const re = /current (session|week \(([^)]+)\)):\s*(\d+)\s*%(?:[^\n]*?\bresets\s+([A-Z][a-z]{2,8}\s+\d{1,2}\s+at\s+\d{1,2}(?::\d{2})?\s*[ap]m\s*\([^)]+\)))?/gi;
  let session: UsageWindow | null = null;
  let weekAll: UsageWindow | null = null;
  const perModel: Record<string, UsageWindow> = {};
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const window: UsageWindow = { usedPercentage: Number(m[3]), resetsAt: m[4] ? parseResetClock(m[4], now) : null };
    if (m[1]!.toLowerCase() === "session") session = window;
    else if (/^all models$/i.test(m[2]!.trim())) weekAll = window;
    else perModel[m[2]!.trim()] = window;
  }
  if (!session && !weekAll && Object.keys(perModel).length === 0) return null;
  return {
    session: session ?? { usedPercentage: 0, resetsAt: null },
    weekAll: weekAll ?? { usedPercentage: 0, resetsAt: null },
    perModel,
  };
}

/** Aggregate windows only (session→5h, week-all→7d), for the cold-start fallback. */
export function parseUsageText(text: string, now = Date.now()): UsageWindows | null {
  const f = parseUsageTextFull(text, now);
  if (!f) return null;
  return { fiveHour: f.session, sevenDay: f.weekAll };
}

/** Env-var identity/credential overrides the claude binary honors BEFORE its
 *  keychain lookup (verified 2.1.205). A probe MUST scrub every one of these or
 *  an ambient value silently meters the wrong account. */
const CRED_ENV_OVERRIDES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

/** One `claude -p '/usage'` invocation → parsed usage, or null if it produced no
 *  limit lines (claude prints only a local-stats footer when its own usage fetch
 *  errors/throttles) or failed to run. */
async function probeUsageOnce(env: Record<string, string>, now: number): Promise<FullUsage | null> {
  let out: string;
  try {
    const p = Bun.spawn([resolveRealClaude(), "-p", "/usage", "--output-format", "json"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    out = await new Response(p.stdout).text();
    const errText = await new Response(p.stderr).text();
    await p.exited;
    if (p.exitCode !== 0) {
      log("usage.probe_failed", { exit: p.exitCode ?? "signal", stderr: errText.trim().slice(0, 200) });
      return null;
    }
  } catch (e) {
    log("usage.probe_failed", { err: String((e as Error).message ?? e) });
    return null;
  }

  const j = z.object({ result: z.string() }).safeParse((() => { try { return JSON.parse(out); } catch { return null; } })());
  const full = parseUsageTextFull(j.success ? j.data.result : out, now);
  if (!full) log("usage.probe_unparsed", { sample: out.trim().slice(0, 120) });
  return full;
}

/**
 * Run `claude -p '/usage'` (free, 0 tokens) and parse all three limit kinds.
 * Pass `configDir` to sample a specific account (its CLAUDE_CONFIG_DIR); omit to
 * sample the live account. All ambient credential overrides are scrubbed so the
 * probe meters exactly the OAuth credential in the (possibly namespaced)
 * keychain item. The empty-footer case (claude's own usage call throttled) is
 * transient, so retry it a couple of times. Returns null if it never yields data.
 */
export async function probeUsage(configDir?: string, now = Date.now()): Promise<FullUsage | null> {
  const env: Record<string, string> = { ...process.env, TOKENMAXXING_PROBE: "1" };
  for (const k of CRED_ENV_OVERRIDES) delete env[k];
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

  for (let attempt = 0; ; attempt++) {
    const full = await probeUsageOnce(env, now);
    if (full || attempt >= 2) return full;
    await delay(1500);
  }
}
