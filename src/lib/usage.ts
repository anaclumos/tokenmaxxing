import { omit } from "es-toolkit";
import { z } from "zod";
import { claudeUserAgent } from "./claudebin.ts";
import { http, safeErrorDetail } from "./http.ts";
import { errorMessage, log } from "./log.ts";
import { env } from "./paths.ts";
import type { ResetClaim } from "./provider.ts";
import { EpochSecondsSchema, InstantSchema, JsonTextSchema, RateLimitsStdinSchema, type BankedReset, type ModelInfo, type UsageWindow, type UsageWindows, type Window } from "./types.ts";

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

const StreamWindowSchema = z.looseObject({ utilization: z.number(), resetsAt: EpochSecondsSchema });
const StreamLineSchema = z.looseObject({
  type: z.string(),
  rate_limit_info: z
    .looseObject({
      unifiedWindows: z.looseObject({ five_hour: StreamWindowSchema.optional(), seven_day: StreamWindowSchema.optional() }).optional(),
    })
    .optional(),
});

export function parseStreamLine(value: unknown): { type: string; windows: UsageWindows | null } | null {
  const parsed = StreamLineSchema.safeParse(value);
  if (!parsed.success) return null;
  const unified = parsed.data.type === "rate_limit_event" ? parsed.data.rate_limit_info?.unifiedWindows : undefined;
  const win = (w: z.infer<typeof StreamWindowSchema>): UsageWindow => ({ usedPercentage: Math.round(w.utilization * 100), resetsAt: w.resetsAt });
  const windows = unified?.five_hour && unified.seven_day ? { fiveHour: win(unified.five_hour), sevenDay: win(unified.seven_day), perModel: {} } : null;
  return { type: parsed.data.type, windows };
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
  isApiErrorMessage: z.boolean().optional(),
  apiErrorIsTransient: z.boolean().optional(),
  apiError: z.string().optional(),
  error: z.string().optional(),
  errorDetails: z.string().optional(),
  quotaLimits: z.looseObject({ rateLimitType: z.string().optional(), resetsAt: EpochSecondsSchema.optional() }).optional(),
  message: z.looseObject({ content: z.unknown().optional() }).optional(),
});
export type TranscriptRow = z.infer<typeof TranscriptRowSchema>;

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

export async function readTranscriptTail(path: string): Promise<TranscriptRow[]> {
  const file = Bun.file(path);
  const start = Math.max(0, file.size - TRANSCRIPT_TAIL_BYTES);
  let text = await file.slice(start).text();
  if (start > 0) text = text.slice(text.indexOf("\n") + 1);
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

export const ENFORCED_ERRORS = ["rate_limit", "oauth_org_not_allowed"];

export function findEnforcedRow(input: { rows: TranscriptRow[]; error: string; lastAssistantMessage: string | undefined }): TranscriptRow | null {
  const { rows, error, lastAssistantMessage } = input;
  return rows.findLast((row) => row.isApiErrorMessage === true && row.error === error && transcriptRowText(row) === lastAssistantMessage) ?? null;
}

export type EnforcedClass =
  | { kind: "session"; resetsAt: number | null }
  | { kind: "weekly"; resetsAt: number | null }
  | { kind: "model"; family: string; resetsAt: number | null }
  | { kind: "credits"; family: string; resetsAt: null }
  | { kind: "org"; resetsAt: null }
  | { kind: "overage"; resetsAt: null };

const ErrorBodySchema = z.looseObject({
  error: z.looseObject({ type: z.string().optional(), details: z.looseObject({ error_code: z.string().optional() }).optional() }).optional(),
});

const CREDITS_FAMILY = "fable";

export function parseErrorBody(errorDetails: string | undefined): z.infer<typeof ErrorBodySchema> | null {
  if (!errorDetails) return null;
  const at = errorDetails.indexOf("{");
  if (at < 0) return null;
  const body = ErrorBodySchema.safeParse(JsonTextSchema.safeParse(errorDetails.slice(at)).data);
  return body.success ? body.data : null;
}

export function classifyEnforcedLimit(row: TranscriptRow, switchModels: string[]): EnforcedClass | null {
  if (row.error === "oauth_org_not_allowed") return { kind: "org", resetsAt: null };
  if (row.apiError === "model_requires_usage_credits") return { kind: "credits", family: CREDITS_FAMILY, resetsAt: null };
  const q = row.quotaLimits;
  if (!q) return null;
  const resetsAt = q.resetsAt ?? null;
  const type = q.rateLimitType ?? "";
  if (type === "five_hour") return { kind: "session", resetsAt };
  if (type === "seven_day") return { kind: "weekly", resetsAt };
  if (type === "overage") return { kind: "overage", resetsAt: null };
  const family = switchModels.find((f) => type.includes(f));
  return family ? { kind: "model", family, resetsAt } : null;
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

const CRED_ENV_OVERRIDES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
] as const;

export function scrubCredEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const overridden = CRED_ENV_OVERRIDES.some((k) => k !== "CLAUDE_SECURESTORAGE_CONFIG_DIR" && env[k]);
  return omit(env, overridden ? [...CRED_ENV_OVERRIDES, "ANTHROPIC_BASE_URL"] : CRED_ENV_OVERRIDES);
}

export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_URL = env("TOKENMAXXING_OAUTH_USAGE_URL", OAUTH_USAGE_URL);
const USAGE_DEADLINE_MS = 10_000;

const ResetsAtSchema = InstantSchema.nullish();
const UsageLimitSchema = z.looseObject({ utilization: z.number(), resets_at: ResetsAtSchema });
const UsageScopedLimitSchema = z.looseObject({
  kind: z.string(),
  percent: z.number(),
  resets_at: ResetsAtSchema,
  scope: z.looseObject({ model: z.looseObject({ display_name: z.string() }) }),
});
const ResetGrantSchema = z.looseObject({ id: z.string(), resets_left: z.number(), clears: z.array(z.string()), paused: z.boolean(), usable_now: z.boolean() });
const CedarEmberSchema = z.looseObject({ next_grant_id: z.string().nullish(), grants: z.array(z.looseObject({ id: z.string() })) });
const UsageResponseSchema = z.looseObject({
  five_hour: UsageLimitSchema.nullish(),
  seven_day: UsageLimitSchema.nullish(),
  limits: z.array(z.unknown()).nullish(),
  cedar_ember: z.unknown().optional(),
});

function unreadableGrant(error: z.ZodError): undefined {
  log("usage.cedar_ember_unreadable", { issue: z.prettifyError(error).slice(0, 200) });
  return undefined;
}

function weeklyGrant(raw: unknown): BankedReset | undefined {
  if (raw == null) return undefined;
  const block = CedarEmberSchema.safeParse(raw);
  if (!block.success) return unreadableGrant(block.error);
  const named = block.data.grants.find((g) => g.id === block.data.next_grant_id);
  if (named == null) return undefined;
  const next = ResetGrantSchema.safeParse(named);
  if (!next.success) return unreadableGrant(next.error);
  const g = next.data;
  return g.usable_now && !g.paused && g.resets_left > 0 && g.clears.includes("seven_day") ? { grant: g.id } : undefined;
}

function scopedRows(limits: unknown[]): Record<string, UsageWindow> {
  const perModel: Record<string, UsageWindow> = {};
  for (const raw of limits) {
    const row = UsageScopedLimitSchema.safeParse(raw);
    if (!row.success || row.data.kind !== "weekly_scoped") continue;
    perModel[row.data.scope.model.display_name] = { usedPercentage: row.data.percent, resetsAt: row.data.resets_at ?? null };
  }
  return perModel;
}

const RetryAfterSecondsSchema = z.coerce.number().int().positive();

export type UsageRead = { ok: true; usage: UsageWindows } | { ok: false; retryAt: number | null };

export async function fetchUsageDirect(accessToken: string): Promise<UsageRead> {
  let res: Response;
  try {
    res = await http.get(USAGE_URL, {
      searchParams: { at_wall: 1, skip_spend: 1 },
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "User-Agent": claudeUserAgent() },
      signal: AbortSignal.timeout(USAGE_DEADLINE_MS),
    });
  } catch (e) {
    log("usage.get_failed", { err: errorMessage(e) });
    return { ok: false, retryAt: null };
  }
  if (!res.ok) {
    const retryAfter = res.status === 429 ? RetryAfterSecondsSchema.safeParse(res.headers.get("retry-after")).data : undefined;
    log("usage.get_failed", { status: res.status, retryAfter });
    return { ok: false, retryAt: retryAfter != null ? Date.now() + retryAfter * 1000 : null };
  }
  const parsed = UsageResponseSchema.safeParse(JsonTextSchema.safeParse(await res.text()).data);
  if (!parsed.success || !parsed.data.five_hour || !parsed.data.seven_day) {
    log("usage.get_incomplete", { ok: parsed.success, issue: parsed.success ? undefined : z.prettifyError(parsed.error).slice(0, 200) });
    return { ok: false, retryAt: null };
  }
  const win = (w: z.infer<typeof UsageLimitSchema>): UsageWindow => ({ usedPercentage: w.utilization, resetsAt: w.resets_at ?? null });
  return {
    ok: true,
    usage: { fiveHour: win(parsed.data.five_hour), sevenDay: win(parsed.data.seven_day), perModel: scopedRows(parsed.data.limits ?? []), bankedReset: weeklyGrant(parsed.data.cedar_ember) },
  };
}

const ClaimResponseSchema = z.looseObject({ result: z.string(), reason: z.string().nullish() });

export async function claimResetGrant(input: { accessToken: string; organizationUuid: string; grant: string }, signal: AbortSignal): Promise<ResetClaim> {
  const res = await http.post(new URL(`/api/organizations/${input.organizationUuid}/reset_rate_limits`, USAGE_URL), {
    headers: { Authorization: `Bearer ${input.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": claudeUserAgent() },
    json: { program: "cedar_ember", grant_id: input.grant, request_id: crypto.randomUUID() },
    signal,
  });
  const text = await res.text();
  if (!res.ok) return { reset: false, detail: `HTTP ${res.status}: ${safeErrorDetail({ text })}` };
  const claim = ClaimResponseSchema.safeParse(JsonTextSchema.safeParse(text).data).data;
  if (claim == null) return { reset: false, detail: "unreadable body" };
  return { reset: claim.result === "reset", detail: claim.reason != null ? `${claim.result}: ${claim.reason}` : claim.result };
}
