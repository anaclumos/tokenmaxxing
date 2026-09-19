import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { delay } from "es-toolkit";
import { z } from "zod";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV, resolveRealClaude } from "./claudebin.ts";
import { http } from "./http.ts";
import { errorMessage, log } from "./log.ts";
import { env } from "./paths.ts";
import { EpochSecondsSchema, JsonTextSchema, RateLimitsStdinSchema, type ModelInfo, type UsageWindow, type UsageWindows, type Window } from "./types.ts";

const win = (w: { used_percentage: number; resets_at?: number | null }): UsageWindow => ({
  usedPercentage: w.used_percentage,
  resetsAt: w.resets_at ?? null,
});

export function parseStatusLineStdin(obj: unknown): UsageWindows | null {
  const parsed = RateLimitsStdinSchema.safeParse(obj);
  if (!parsed.success) return null;
  const rl = parsed.data.rate_limits;
  if (!rl?.five_hour || !rl.seven_day) return null;
  return { fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day), perModel: {} };
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

const MODEL_FAMILIES = ["sonnet", "opus", "haiku", "fable"];

export function modelFromFlag(value: string | null): ModelInfo | null {
  const name = value?.split("[")[0]?.trim() ?? "";
  const tokens = familyTokens(name);
  return MODEL_FAMILIES.some((f) => tokens.includes(f)) ? { id: name, display: name } : null;
}

const TranscriptBlockSchema = z.looseObject({ type: z.string().optional(), text: z.string().optional() });
export const TranscriptRowSchema = z.looseObject({
  type: z.string().optional(),
  timestamp: z.string().optional(),
  isApiErrorMessage: z.boolean().optional(),
  apiErrorIsTransient: z.boolean().optional(),
  error: z.string().optional(),
  errorDetails: z.string().optional(),
  quotaLimits: z.looseObject({ rateLimitType: z.string().optional(), resetsAt: EpochSecondsSchema.optional() }).optional(),
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
    const parsed = TranscriptRowSchema.safeParse(JsonTextSchema.safeParse(line).data);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

export function transcriptRowText(row: TranscriptRow): string {
  const blocks = z.array(TranscriptBlockSchema).safeParse(row.message?.content);
  if (!blocks.success) return "";
  return blocks.data.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
}

const ROW_RECENCY_MS = 60_000;

export function findEnforcedRow(input: { rows: TranscriptRow[]; lastAssistantMessage: string | undefined; now: number }): TranscriptRow | null {
  const { rows, lastAssistantMessage, now } = input;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.isApiErrorMessage !== true || row.error !== "rate_limit") continue;
    const ts = row.timestamp ? Date.parse(row.timestamp) : Number.NaN;
    const byContent = lastAssistantMessage != null && lastAssistantMessage !== "" && transcriptRowText(row) === lastAssistantMessage;
    const byRecency = Number.isFinite(ts) && Math.abs(now - ts) <= ROW_RECENCY_MS;
    if (byContent || byRecency) return row;
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
  const body = ErrorBodySchema.safeParse(JsonTextSchema.safeParse(errorDetails.slice(at)).data);
  return body.success ? body.data : null;
}

export function classifyEnforcedLimit(row: TranscriptRow, switchModels: string[]): EnforcedClass | null {
  const q = row.quotaLimits;
  if (q) {
    const resetsAt = q.resetsAt ?? null;
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

const FIVE_HOURS_S = 5 * 3600;
const WEEK_S = 7 * 24 * 3600;

export function windowsOf(u: UsageWindows, at: number): Window[] {
  return [
    { name: null, ...u.fiveHour, windowSeconds: FIVE_HOURS_S, sampledAt: at },
    { name: null, ...u.sevenDay, windowSeconds: WEEK_S, sampledAt: at },
    ...Object.entries(u.perModel).map(([name, w]) => ({ name, ...w, windowSeconds: WEEK_S, sampledAt: at })),
  ];
}

export function mergeWindows(next: Window[], prev: Window[]): Window[] {
  const named = (ws: Window[]) => ws.filter((w) => w.name != null);
  const newest = (ws: Window[]) => Math.max(0, ...ws.map((w) => w.sampledAt));
  const rows = named(next).length > 0 && newest(named(prev)) <= newest(named(next)) ? named(next) : named(prev);
  return [...next.filter((w) => w.name == null), ...rows];
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

export function scrubCredentialEnv(env: Record<string, string>): Record<string, string> {
  const scrubbed = { ...env };
  for (const k of CRED_ENV_OVERRIDES) delete scrubbed[k];
  return scrubbed;
}

export type ProbeTarget = { configDir: string; store: string };

export async function refreshViaProbe(target: ProbeTarget): Promise<boolean> {
  const env = scrubCredentialEnv({ ...process.env, TOKENMAXXING_PROBE: "1", [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH) });
  env.CLAUDE_CONFIG_DIR = target.configDir;
  env.CLAUDE_SECURESTORAGE_CONFIG_DIR = target.store;
  try {
    const p = Bun.spawn([resolveRealClaude(), "-p", "/usage", "--output-format", "json"], { env, stdout: "ignore", stderr: "pipe", timeout: PROBE_KILL_MS, killSignal: "SIGKILL" });
    const stderr = await Promise.race([new Response(p.stderr).text(), p.exited.then(() => delay(PIPE_GRACE_MS)).then(() => null)]);
    await p.exited;
    if (stderr === null) {
      log("usage.probe_failed", { err: "output pipes still open after child exit (leaked descendant)" });
      return false;
    }
    if (p.exitCode !== 0) {
      log("usage.probe_failed", { exit: p.exitCode ?? "signal", stderr: stderr.trim().slice(0, 200) });
      return false;
    }
    return true;
  } catch (e) {
    log("usage.probe_failed", { err: errorMessage(e) });
    return false;
  }
}

const USAGE_URL = env("TOKENMAXXING_OAUTH_USAGE_URL", "https://api.anthropic.com/api/oauth/usage");
const USAGE_DEADLINE_MS = 10_000;

const ResetsAtSchema = z.iso.datetime({ offset: true }).transform((iso) => Date.parse(iso)).nullish();
const UsageLimitSchema = z.looseObject({ utilization: z.number(), resets_at: ResetsAtSchema });
const UsageScopedLimitSchema = z.looseObject({
  kind: z.string(),
  percent: z.number(),
  resets_at: ResetsAtSchema,
  scope: z.looseObject({ model: z.looseObject({ display_name: z.string() }) }),
});
const UsageResponseSchema = z.looseObject({
  five_hour: UsageLimitSchema.nullish(),
  seven_day: UsageLimitSchema.nullish(),
  limits: z.array(z.unknown()).nullish(),
});

function scopedRows(limits: unknown[]): Record<string, UsageWindow> {
  const perModel: Record<string, UsageWindow> = {};
  for (const raw of limits) {
    const row = UsageScopedLimitSchema.safeParse(raw);
    if (!row.success || row.data.kind !== "weekly_scoped") continue;
    perModel[row.data.scope.model.display_name] = { usedPercentage: row.data.percent, resetsAt: row.data.resets_at ?? null };
  }
  return perModel;
}

export async function fetchUsageDirect(accessToken: string): Promise<UsageWindows | null> {
  let res: Response;
  try {
    res = await http.get(USAGE_URL, {
      searchParams: { at_wall: 1, skip_spend: 1 },
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(USAGE_DEADLINE_MS),
    });
  } catch (e) {
    log("usage.get_failed", { err: errorMessage(e) });
    return null;
  }
  if (!res.ok) {
    log("usage.get_failed", { status: res.status });
    return null;
  }
  const parsed = UsageResponseSchema.safeParse(JsonTextSchema.safeParse(await res.text()).data);
  if (!parsed.success || !parsed.data.five_hour || !parsed.data.seven_day) {
    log("usage.get_incomplete", { ok: parsed.success, issue: parsed.success ? undefined : z.prettifyError(parsed.error).slice(0, 200) });
    return null;
  }
  const win = (w: z.infer<typeof UsageLimitSchema>): UsageWindow => ({ usedPercentage: w.utilization, resetsAt: w.resets_at ?? null });
  return { fiveHour: win(parsed.data.five_hour), sevenDay: win(parsed.data.seven_day), perModel: scopedRows(parsed.data.limits ?? []) };
}
