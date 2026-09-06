import { closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { delay } from "es-toolkit";
import { z } from "zod";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV, resolveRealClaude } from "./claudebin.ts";
import { errnoCode, errorMessage } from "./errors.ts";
import { tryParseJson } from "./json.ts";
import { log } from "./log.ts";
import { paths } from "./paths.ts";
import { RateLimitsStdinSchema, type ModelInfo, type UsageWindow, type UsageWindows } from "./types.ts";

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

export function parseStatusLineStdin(obj: unknown): UsageWindows | null {
  const parsed = RateLimitsStdinSchema.safeParse(obj);
  if (!parsed.success) return null;
  const rl = parsed.data.rate_limits;
  if (!rl?.five_hour || !rl.seven_day) return null;
  return { fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day) };
}

export function parseStatusLineModel(obj: unknown): ModelInfo | null {
  const parsed = RateLimitsStdinSchema.safeParse(obj);
  if (!parsed.success) return null;
  const m = parsed.data.model;
  if (!m?.id && !m?.display_name) return null;
  return { id: m?.id ?? m?.display_name ?? "", display: m?.display_name ?? m?.id ?? "" };
}

export function familyTokens(s: string): string[] {
  return s.trim().toLowerCase().split(/[\s.-]+/).filter((t) => t.length > 0);
}

export function matchedFamily(model: ModelInfo | null, families: string[]): string | null {
  if (!model) return null;
  const tokens = new Set([...familyTokens(model.id), ...familyTokens(model.display)]);
  return families.find((f) => tokens.has(f)) ?? null;
}

export function gatedFamilies(model: ModelInfo | null, families: string[]): string[] {
  if (!model) return families;
  const family = matchedFamily(model, families);
  return family ? [family] : [];
}

export type FullUsage = {
  session: UsageWindow;
  weekAll: UsageWindow;
  perModel: Record<string, UsageWindow>;
};

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

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

function zonedWallToEpoch(y: number, mon: number, day: number, hour: number, min: number, tz: string): number {
  const guess = Date.UTC(y, mon, day, hour, min);
  const off1 = tzOffsetMs(guess, tz);
  const off2 = tzOffsetMs(guess - off1, tz);
  return guess - off2;
}

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
      return null;
    }
    if (best === null || Math.abs(epoch - now) < Math.abs(best - now)) best = epoch;
  }
  return best;
}

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
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return [];
    throw e;
  }
  let text: string;
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
  const rows: TranscriptRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const row = tryParseJson(TranscriptRowSchema, line);
    if (row) rows.push(row);
  }
  return rows;
}

export function transcriptRowText(row: TranscriptRow): string {
  const blocks = z.array(TranscriptBlockSchema).safeParse(row.message?.content);
  if (!blocks.success) return "";
  return blocks.data.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
}

const ROW_RECENCY_MS = 60_000;

export type EnforcedRow = { row: TranscriptRow; errorAt: number | null };

export function findEnforcedRow(input: { rows: TranscriptRow[]; lastAssistantMessage: string | undefined; now: number }): EnforcedRow | null {
  const { rows, lastAssistantMessage, now } = input;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.isApiErrorMessage !== true || row.error !== "rate_limit") continue;
    const ts = row.timestamp ? Date.parse(row.timestamp) : Number.NaN;
    const byContent = lastAssistantMessage != null && lastAssistantMessage !== "" && transcriptRowText(row) === lastAssistantMessage;
    const byRecency = Number.isFinite(ts) && Math.abs(now - ts) <= ROW_RECENCY_MS;
    if (!byContent && !byRecency) continue;
    return { row, errorAt: Number.isFinite(ts) ? ts : null };
  }
  return null;
}

export type EnforcedClass =
  | { kind: "session"; resetsAt: number | null }
  | { kind: "weekly"; resetsAt: number | null }
  | { kind: "model"; family: string; resetsAt: number | null };

const ErrorBodySchema = z.looseObject({
  error: z.looseObject({ type: z.string().optional(), details: z.looseObject({ error_code: z.string().optional() }).optional() }).optional(),
});

const CREDITS_GATED_FAMILIES = ["fable"];

export function parseErrorBody(errorDetails: string | undefined): z.infer<typeof ErrorBodySchema> | null {
  if (!errorDetails) return null;
  const at = errorDetails.indexOf("{");
  if (at < 0) return null;
  return tryParseJson(ErrorBodySchema, errorDetails.slice(at));
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
  if (parseErrorBody(row.errorDetails)?.error?.type !== "rate_limit_error") return null;
  const family = switchModels.find((f) => CREDITS_GATED_FAMILIES.includes(f));
  return family ? { kind: "model", family, resetsAt: null } : null;
}

export function parseUsageTextFull(text: string, now = Date.now()): FullUsage | null {
  if (!text) return null;
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
  if (!session || !weekAll) return null;
  return { session, weekAll, perModel };
}

export function parseUsageText(text: string, now = Date.now()): UsageWindows | null {
  const f = parseUsageTextFull(text, now);
  if (!f) return null;
  return { fiveHour: f.session, sevenDay: f.weekAll };
}

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

const PROBE_KILL_MS = 60_000;
const PIPE_GRACE_MS = 2_000;

type SpawnResult = { exitCode: number | null; stdout: string; stderr: string };

async function spawnClaudeBounded(cmd: string[], env: Record<string, string>, cwd?: string): Promise<SpawnResult | null> {
  const p = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe", timeout: PROBE_KILL_MS, killSignal: "SIGKILL" });
  const reads = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const settled = await Promise.race([reads, p.exited.then(() => delay(PIPE_GRACE_MS)).then(() => null)]);
  if (settled === null) return null;
  const [stdout, stderr] = settled;
  await p.exited;
  return { exitCode: p.exitCode, stdout, stderr };
}

const ProbeOutputSchema = z.object({ result: z.string() });

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
    log("usage.probe_failed", { err: errorMessage(e) });
    return null;
  }

  const text = tryParseJson(ProbeOutputSchema, out)?.result ?? out;
  const full = parseUsageTextFull(text, now);
  if (!full) {
    log("usage.probe_unparsed", { sample: text.trim().slice(0, 200) });
  } else {
    const clockLine = text.split("\n").find((l) => /^current /i.test(l) && /\bresets\b/i.test(l));
    if (clockLine && [full.session, full.weekAll, ...Object.values(full.perModel)].every((w) => w.resetsAt === null)) {
      log("usage.reset_clock_unparsed", { sample: clockLine.slice(0, 120) });
    }
  }
  return full;
}

const PROBE_RETRY_DELAYS_MS = [2000, 5000];

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

const PING_ARGS = [
  "-p", "Reply with exactly: ok",
  "--model", "haiku",
  "--settings", '{"disableAllHooks":true}',
  "--output-format", "json",
];

const PingResultSchema = z.looseObject({ is_error: z.boolean().optional(), result: z.string().optional(), session_id: z.string().optional() });

export type PingFailure = { reason: string; rejected: boolean };

export function transcriptSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function pingTranscriptPath(input: { configDir: string; cwd: string; sessionId: string }): string {
  return join(input.configDir, "projects", transcriptSlug(input.cwd), `${input.sessionId}.jsonl`);
}

const LIMIT_LABELS: Record<string, string> = { five_hour: "5h", seven_day: "weekly" };

export function pingRejection(rows: TranscriptRow[]): string | null {
  const row = rows.findLast((r) => r.isApiErrorMessage === true);
  if (!row || row.error !== "rate_limit" || row.apiErrorIsTransient === true) return null;
  const type = row.quotaLimits?.rateLimitType ?? "";
  if (type === "" && parseErrorBody(row.errorDetails)?.error?.type !== "rate_limit_error") return null;
  const label = LIMIT_LABELS[type] ?? (type !== "" ? type.replace(/_/g, " ") : "usage");
  const text = transcriptRowText(row);
  return `${label} limit${text ? `: ${text}` : ""}`;
}

export async function pingSession(configDir?: string): Promise<PingFailure | null> {
  const cwd = join(paths.sampleDir, "ping-cwd");
  const fail = (reason: string, rejected = false): PingFailure => {
    log("usage.ping_failed", { dir: configDir ?? "live", rejected, reason: reason.slice(0, 200) });
    return { reason, rejected };
  };
  let r: SpawnResult | null;
  try {
    mkdirSync(cwd, { recursive: true });
    r = await spawnClaudeBounded([resolveRealClaude(), ...PING_ARGS], probeEnv(configDir), cwd);
  } catch (e) {
    return fail(errorMessage(e));
  }
  if (r === null) return fail("output pipes still open after child exit (leaked descendant)");
  const result = tryParseJson(PingResultSchema, r.stdout);
  if (r.exitCode === 0 && result?.is_error === false) {
    log("usage.ping_ok", { dir: configDir ?? "live" });
    return null;
  }
  if (result?.session_id) {
    const transcript = pingTranscriptPath({ configDir: configDir ?? paths.claudeDir, cwd, sessionId: result.session_id });
    const rejection = pingRejection(readTranscriptTail(transcript));
    if (rejection) return fail(`rejected at the ${rejection}`.slice(0, 200), true);
  }
  if (r.exitCode !== 0) {
    const detail = result?.result?.trim() || r.stderr.trim() || r.stdout.trim();
    return fail(`claude exited ${r.exitCode ?? "on signal"}: ${detail.slice(0, 160)}`);
  }
  if (result?.is_error === true) return fail((result.result?.trim() || "request errored").slice(0, 160));
  return fail(`unrecognized ping output: ${r.stdout.trim().slice(0, 120)}`);
}
