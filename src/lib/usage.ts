// Usage data from two sources: statusLine stdin (pushed every turn, aggregate
// windows only, epoch resets) and `claude -p '/usage'` (free, 0 tokens, all
// three limit kinds). `/usage` is a client-side command that renders the same
// figures claude's own usage screen shows; we run it in a throwaway
// CLAUDE_CONFIG_DIR to sample a parked account without disturbing the live login.

import { closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { delay } from "es-toolkit";
import { z } from "zod";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV, resolveRealClaude } from "./claudebin.ts";
import { log } from "./log.ts";
import { paths } from "./paths.ts";
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

const win = (w: { used_percentage: number; resets_at?: number | null }): UsageWindow => ({
  usedPercentage: w.used_percentage,
  resetsAt: normalizeResetsAt(w.resets_at),
});

/** Extract the two AGGREGATE windows from statusLine stdin. null if absent.
 *  All-or-nothing on the aggregates (mirrors the /usage parser): fabricating
 *  0% for a missing window would make unmeasured read as safe. */
export function parseStatusLineStdin(obj: unknown): UsageWindows | null {
  const parsed = RateLimitsStdinSchema.safeParse(obj);
  if (!parsed.success) return null;
  const rl = parsed.data.rate_limits;
  if (!rl?.five_hour || !rl.seven_day) return null;
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

/** Lowercased word tokens of a model id or display string: "claude-opus-4-8" /
 *  "Opus 4.8" -> ["claude","opus","4","8"] / ["opus","4","8"]. Model naming
 *  drifts per release ("Fable" became "Fable 5" in 2.1.206, and id grammar has
 *  historically flipped between family-first and version-first), so gates match
 *  a family token anywhere instead of an exact string - an exact-string gate
 *  silently disabled the per-model check in the 2026-07-09/10 incidents. */
export function familyTokens(s: string): string[] {
  return s.trim().toLowerCase().split(/[\s.-]+/).filter((t) => t.length > 0);
}

/** The switchModels family the active model belongs to, from its id OR display
 *  tokens; null when the model is not capacity-constrained. */
export function matchedFamily(model: ModelInfo | null, families: string[]): string | null {
  if (!model) return null;
  const tokens = new Set([...familyTokens(model.id), ...familyTokens(model.display)]);
  return families.find((f) => tokens.has(f)) ?? null;
}

/** Families whose per-model weekly cap gates a switch, given the active model:
 *  the model's own family when it is capacity-constrained, none when it is a
 *  known-unconstrained model, and EVERY configured family when the model is
 *  unknown. The unknown case matters on headless boxes: a swap clears the
 *  snapshots and only an actively-rendering statusLine restores the model, so
 *  the periodic check ran model-blind for hours while the active account sat at
 *  its Fable cap (the 2026-07-12 ARM-box incident). */
export function gatedFamilies(model: ModelInfo | null, families: string[]): string[] {
  if (!model) return families;
  const family = matchedFamily(model, families);
  return family ? [family] : [];
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
 * `Jul 10, 3:30pm (Asia/Seoul)` to epoch ms. The day-time glue is not stable
 * across claude installs (observed on 2.1.206: ` at ` on macOS, `, ` on Linux);
 * exactly those two glues are accepted, same-line only, so a third drift shows
 * up as an unparsed clock (and the usage.reset_clock_unparsed log) instead of a
 * guessed instant. The text carries no year, so we pick the year whose resulting
 * instant is nearest `now` (resets are always days away, so the correct year
 * wins by ~360 days). Returns null if unparseable.
 */
export function parseResetClock(clock: string, now = Date.now()): number | null {
  const m = clock.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:[^\S\n]+at[^\S\n]+|,[^\S\n]*)(\d{1,2})(?::(\d{2}))?\s*([ap])m\s*\(([^)]+)\)/i);
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

/** Compact time-until-reset: the largest unit only ("6d", "2h", "45m"),
 *  floored to "1m" so a live window never reads as zero, and "" once the reset
 *  has passed (the window is simply empty again). Non-empty output always ends
 *  in a unit letter, so the statusLine's digit-leading used-percent glued
 *  after it stays parseable. Lives here (not cli/render.ts) so headless lib
 *  consumers stay off the terminal-rendering module. */
export function fmtResetShort(epochMs: number | null | undefined, now = Date.now()): string {
  if (epochMs == null) return "";
  const dsec = Math.round((epochMs - now) / 1000);
  if (dsec <= 0) return "";
  const d = Math.floor(dsec / 86400);
  const h = Math.floor((dsec % 86400) / 3600);
  const m = Math.floor((dsec % 3600) / 60);
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h`;
  return `${Math.max(m, 1)}m`;
}

const TranscriptBlockSchema = z.looseObject({ type: z.string().optional(), text: z.string().optional() });
export const TranscriptRowSchema = z.looseObject({
  type: z.string().optional(),
  timestamp: z.string().optional(),
  isApiErrorMessage: z.boolean().optional(),
  apiErrorIsTransient: z.boolean().optional(),
  error: z.string().optional(),
  errorDetails: z.string().optional(),
  quotaLimits: z.looseObject({ rateLimitType: z.string().optional(), resetsAt: z.number().optional() }).optional(),
  message: z.looseObject({ content: z.unknown().optional() }).optional(),
});
export type TranscriptRow = z.infer<typeof TranscriptRowSchema>;

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

export function readTranscriptTail(path: string, maxBytes = TRANSCRIPT_TAIL_BYTES): TranscriptRow[] {
  let text: string;
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const rows: TranscriptRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = TranscriptRowSchema.safeParse(JSON.parse(line));
      if (parsed.success) rows.push(parsed.data);
    } catch {}
  }
  return rows;
}

export function transcriptRowText(row: TranscriptRow): string {
  const blocks = z.array(TranscriptBlockSchema).safeParse(row.message?.content);
  if (!blocks.success) return "";
  return blocks.data.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
}

const ROW_RECENCY_MS = 60_000;

const EnforcedRowSchema = z.object({
  row: TranscriptRowSchema,
  turnStartTs: z.number().nullable(),
});
export type EnforcedRow = z.infer<typeof EnforcedRowSchema>;

export function findEnforcedRow(input: { rows: TranscriptRow[]; lastAssistantMessage: string | undefined; now: number }): EnforcedRow | null {
  const { rows, lastAssistantMessage, now } = input;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.isApiErrorMessage !== true || row.error !== "rate_limit") continue;
    const ts = row.timestamp ? Date.parse(row.timestamp) : Number.NaN;
    const byContent = lastAssistantMessage != null && lastAssistantMessage !== "" && transcriptRowText(row) === lastAssistantMessage;
    const byRecency = Number.isFinite(ts) && Math.abs(now - ts) <= ROW_RECENCY_MS;
    if (!byContent && !byRecency) continue;
    let turnStartTs: number | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const prev = rows[j]!;
      if (prev.type !== "user") continue;
      const pts = prev.timestamp ? Date.parse(prev.timestamp) : Number.NaN;
      turnStartTs = Number.isFinite(pts) ? pts : null;
      break;
    }
    return { row, turnStartTs };
  }
  return null;
}

export const EnforcedClassSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), resetsAt: z.number().nullable() }),
  z.object({ kind: z.literal("weekly"), resetsAt: z.number().nullable() }),
  z.object({ kind: z.literal("model"), family: z.string(), resetsAt: z.number().nullable() }),
]);
export type EnforcedClass = z.infer<typeof EnforcedClassSchema>;

const CreditsBodySchema = z.looseObject({
  error: z.looseObject({ details: z.looseObject({ error_code: z.string().optional() }).optional() }).optional(),
});

function creditsRequired(errorDetails: string | undefined): boolean {
  if (!errorDetails) return false;
  const at = errorDetails.indexOf("{");
  if (at < 0) return false;
  try {
    const body = CreditsBodySchema.safeParse(JSON.parse(errorDetails.slice(at)));
    return body.success && body.data.error?.details?.error_code === "credits_required";
  } catch {
    return false;
  }
}

export function classifyEnforcedLimit(row: TranscriptRow, switchModels: string[]): EnforcedClass | null {
  const q = row.quotaLimits;
  if (q) {
    const resetsAt = q.resetsAt != null ? normalizeResetsAt(q.resetsAt) : null;
    const type = q.rateLimitType ?? "";
    if (type === "five_hour") return { kind: "session", resetsAt };
    if (type === "seven_day") return { kind: "weekly", resetsAt };
    const family = switchModels.find((f) => type.includes(f));
    return family ? { kind: "model", family, resetsAt } : null;
  }
  if (row.apiErrorIsTransient === true) return null;
  const tokens = familyTokens(transcriptRowText(row));
  const family = switchModels.find((f) => tokens.includes(f));
  if (!family) return null;
  if (tokens.includes("limit") || creditsRequired(row.errorDetails)) return { kind: "model", family, resetsAt: null };
  return null;
}

/**
 * Parse `claude -p '/usage'` .result text into all three limit kinds:
 *   Current session: N% used ... resets <clock>        → session (5h)
 *   Current week (all models): N% used ... resets ...  → weekAll (7d aggregate)
 *   Current week (<Model>): N% used ... resets ...     → perModel[<Model>]
 */
export function parseUsageTextFull(text: string, now = Date.now()): FullUsage | null {
  if (!text) return null;
  // The reset clock is required in full (month day[, | at ]h[:mm]am/pm (tz))
  // inside its optional group, so the lazy bridge is forced to find it when
  // present yet the group cleanly skips a line that has no clock. The bridge
  // refuses to cross another "Current" so a dateless clock ("resets Jul 8.")
  // can never steal the NEXT entry's clock or swallow that entry. The day-time
  // glue is not stable across installs (observed on 2.1.206: ` at ` on macOS,
  // `, ` on Linux); exactly those two are accepted, same-line only, so a third
  // drift surfaces in the usage.reset_clock_unparsed log instead of misparsing.
  const re = /current (session|week \(([^)]+)\)):\s*(\d+)\s*%(?:(?:(?!current)[^\n])*?\bresets\s+([A-Z][a-z]{2,8}\s+\d{1,2}(?:[^\S\n]+at[^\S\n]+|,[^\S\n]*)\d{1,2}(?::\d{2})?\s*[ap]m\s*\([^)]+\)))?/gi;
  let session: UsageWindow | null = null;
  let weekAll: UsageWindow | null = null;
  const perModel: Record<string, UsageWindow> = {};
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const window: UsageWindow = { usedPercentage: Number(m[3]), resetsAt: m[4] ? parseResetClock(m[4], now) : null };
    if (m[1]!.toLowerCase() === "session") session = window;
    else if (/^all models$/i.test(m[2]!.trim())) weekAll = window;
    else perModel[m[2]!.trim()] = window;
  }
  // All-or-nothing on the aggregates: every captured /usage output shows both
  // rows, so a missing one is format drift, and fabricating 0% for it would
  // make an unmeasured window read as safe (the one thing it must never do).
  if (!session || !weekAll) return null;
  return { session, weekAll, perModel };
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
export const CRED_ENV_OVERRIDES = [
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
/** A probe child that wedges (auth prompt, dead endpoint) must never block the
 *  Stop/SessionStart hooks or the status flock forever; a healthy `/usage`
 *  answers in seconds. */
const PROBE_KILL_MS = 60_000;
/** How long after the child's death to keep waiting for pipe EOF. */
const PIPE_GRACE_MS = 2_000;

const SpawnResultSchema = z.object({
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});
type SpawnResult = z.infer<typeof SpawnResultSchema>;

/** Spawn one bounded claude invocation (shared by the `/usage` probe and the
 *  `--force` ping). SIGKILL after PROBE_KILL_MS: claude traps SIGTERM, and a
 *  wedged child that survives the kill would keep p.exited pending and re-wedge
 *  the read race. Descendants inherit the output pipes, so EOF can lag the
 *  child's death or never arrive at all - a leaked grandchild holding the pipe
 *  wedged the 2026-07-12 probes forever, defeating the kill guard - so the
 *  reads are bounded by child-exit + grace instead of awaiting EOF
 *  unconditionally. Returns null when the pipes were withheld past the grace. */
async function spawnClaudeBounded(
  cmd: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<SpawnResult | null> {
  const p = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => p.kill("SIGKILL"), PROBE_KILL_MS);
  try {
    const reads = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const settled = await Promise.race([
      reads,
      p.exited.then(() => delay(PIPE_GRACE_MS)).then(() => null),
    ]);
    if (settled === null) return null;
    const [stdout, stderr] = settled;
    await p.exited;
    return { exitCode: p.exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

async function probeUsageOnce(env: Record<string, string>, now: number): Promise<FullUsage | null> {
  let out: string;
  try {
    const r = await spawnClaudeBounded([resolveRealClaude(), "-p", "/usage", "--output-format", "json"], env);
    if (r === null) {
      log("usage.probe_failed", { err: "output pipes still open after child exit (leaked descendant)" });
      return null;
    }
    if (r.exitCode !== 0) {
      log("usage.probe_failed", { exit: r.exitCode ?? "signal", stderr: r.stderr.trim().slice(0, 200) });
      return null;
    }
    out = r.stdout;
  } catch (e) {
    log("usage.probe_failed", { err: e instanceof Error ? e.message : String(e) });
    return null;
  }

  const j = z.object({ result: z.string() }).safeParse((() => { try { return JSON.parse(out); } catch { return null; } })());
  const text = j.success ? j.data.result : out;
  const full = parseUsageTextFull(text, now);
  if (!full) {
    log("usage.probe_unparsed", { sample: text.trim().slice(0, 200) });
  } else {
    const clockLine = text.split("\n").find((l) => /^current /i.test(l) && /\bresets\b/i.test(l));
    if (clockLine && [full.session, full.weekAll, ...Object.values(full.perModel)].every((w) => w.resetsAt === null)) {
      // Percentages parsed but every reset clock was dropped: the clock format
      // drifted again. Log the line so the next drift is visible in the log.
      log("usage.reset_clock_unparsed", { sample: clockLine.slice(0, 120) });
    }
  }
  return full;
}

/** Escalating retry delays for the empty-footer case (usage endpoint throttled
 *  or the sampled token busy). Capped at ~7s of sleep: probeUsage runs inside
 *  Stop/SessionStart hooks and under the status flock, and the periodic `check`
 *  timer re-runs every 3 minutes anyway, owning the long-tail retry. */
const PROBE_RETRY_DELAYS_MS = [2000, 5000];

/**
 * Run `claude -p '/usage'` (free, 0 tokens) and parse all three limit kinds.
 * Pass `configDir` to sample a specific account (its CLAUDE_CONFIG_DIR); omit to
 * sample the live account. All ambient credential overrides are scrubbed so the
 * probe meters exactly the OAuth credential in the (possibly namespaced)
 * keychain item. The empty-footer case (claude's own usage call throttled) is
 * transient, so retry with backoff. Returns null if it never yields data.
 */
/** The scrubbed env every probe/ping spawn uses. The child spawns the real
 *  claude DIRECTLY - it never legitimately passes through the wrapper again -
 *  so the depth is preset to the cap and a poisoned pin that leads back to the
 *  wrapper aborts on its first entry (the 2026-07-12 ~1800-process recursion
 *  started as exactly this probe). */
function probeEnv(configDir?: string): Record<string, string> {
  const env: Record<string, string> = { ...process.env, TOKENMAXXING_PROBE: "1", [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH) };
  for (const k of CRED_ENV_OVERRIDES) delete env[k];
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

export async function probeUsage(configDir?: string, now = Date.now()): Promise<FullUsage | null> {
  const env = probeEnv(configDir);

  for (let attempt = 0; ; attempt++) {
    const full = await probeUsageOnce(env, now);
    if (full) return full;
    if (attempt >= PROBE_RETRY_DELAYS_MS.length) {
      log("usage.probe_gave_up", { attempts: attempt + 1 });
      return null;
    }
    await delay(PROBE_RETRY_DELAYS_MS[attempt]!);
  }
}

// ---- `--force` ping --------------------------------------------------------

/** The ping is a REAL (but minimal) inference request: `/usage` is free and
 *  starts nothing, while any metered request opens the account's 5h session
 *  window at the current instant. haiku: the cheapest model (verified $1/$5 per
 *  MTok vs $3+ for every other current tier), and one with no per-model weekly
 *  cap (those exist only for Sonnet and Fable), so a ping never adds to a
 *  per-model cap the policy gates on; its dent in the aggregate 5h/7d windows
 *  is negligible. Hooks are disabled for the nested call
 *  (`--settings`, the only supported way; `--bare` would kill keychain reads)
 *  even though our own hooks already no-op on the probe env. */
const PING_ARGS = [
  "-p", "Reply with exactly: ok",
  "--model", "haiku",
  "--settings", '{"disableAllHooks":true}',
  "--output-format", "json",
];

const PingResultSchema = z.looseObject({ is_error: z.boolean(), result: z.string().optional() });

/**
 * Send one minimal metered request so the account's 5h session window starts
 * NOW instead of lying dormant until first real use. Pass `configDir` to ping a
 * parked account through its isolated dir (credential already installed); omit
 * to ping the live login. Runs from an empty scratch cwd so no project context
 * (CLAUDE.md, project settings) inflates the request. Returns null on success,
 * else the failure reason.
 */
export async function pingSession(configDir?: string): Promise<string | null> {
  const cwd = join(paths.sampleDir, "ping-cwd");
  const fail = (reason: string): string => {
    log("usage.ping_failed", { dir: configDir ?? "live", reason: reason.slice(0, 200) });
    return reason;
  };
  let r: SpawnResult | null;
  try {
    mkdirSync(cwd, { recursive: true });
    r = await spawnClaudeBounded([resolveRealClaude(), ...PING_ARGS], probeEnv(configDir), cwd);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (r === null) return fail("output pipes still open after child exit (leaked descendant)");
  if (r.exitCode !== 0) return fail(`claude exited ${r.exitCode ?? "on signal"}: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 160)}`);
  const parsed = PingResultSchema.safeParse((() => { try { return JSON.parse(r.stdout); } catch { return null; } })());
  if (!parsed.success) return fail(`unrecognized ping output: ${r.stdout.trim().slice(0, 120)}`);
  if (parsed.data.is_error) return fail((parsed.data.result?.trim() || "request errored").slice(0, 160));
  log("usage.ping_ok", { dir: configDir ?? "live" });
  return null;
}
