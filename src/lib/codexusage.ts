import { z } from "zod";
import { http, safeErrorDetail } from "./http.ts";
import { errorMessage } from "./log.ts";
import { env } from "./paths.ts";
import { EpochSecondsSchema, JsonTextSchema, type CodexAuthJson, type CodexUsage, type Window } from "./types.ts";
import { codexIdentityOf } from "./codexauth.ts";
import type { ResetClaim } from "./provider.ts";
import { familyTokens } from "./usage.ts";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_URL = env("TOKENMAXXING_CODEX_USAGE_URL", CODEX_USAGE_URL);

export class CodexUsageReadError extends Error {
  constructor(detail: string) {
    super(`codex usage read failed: ${detail}`);
    this.name = "CodexUsageReadError";
  }
}

const WireWindowSchema = z.looseObject({
  used_percent: z.number(),
  limit_window_seconds: z.number().nullish(),
  reset_at: EpochSecondsSchema.nullish(),
});

const WireRateLimitSchema = z.looseObject({
  primary_window: WireWindowSchema.nullish(),
  secondary_window: WireWindowSchema.nullish(),
});

const WireUsageSchema = z.looseObject({
  account_id: z.string(),
  email: z.string().nullish(),
  plan_type: z.string().nullish(),
  rate_limit: WireRateLimitSchema.nullish(),
  credits: z.looseObject({ has_credits: z.boolean().nullish() }).nullish(),
  rate_limit_reset_credits: z.looseObject({ available_count: z.number() }).nullish(),
  additional_rate_limits: z
    .array(z.looseObject({ limit_name: z.string(), rate_limit: WireRateLimitSchema.nullish() }))
    .nullish(),
});

function toWindows(rateLimit: z.infer<typeof WireRateLimitSchema> | null | undefined, name: string | null, at: number): Window[] {
  const out: Window[] = [];
  for (const wire of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    if (wire == null) continue;
    out.push({
      name,
      usedPercentage: wire.used_percent,
      resetsAt: wire.reset_at ?? null,
      windowSeconds: wire.limit_window_seconds ?? null,
      sampledAt: at,
    });
  }
  return out;
}

function codexHeaders(auth: CodexAuthJson): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    "ChatGPT-Account-Id": codexIdentityOf({ auth }).accountId,
    "User-Agent": "codex-cli",
  };
}

export async function fetchCodexUsage(input: { auth: CodexAuthJson; at: number }): Promise<CodexUsage> {
  const { auth, at } = input;
  let res: Response;
  try {
    res = await http.get(USAGE_URL, { headers: codexHeaders(auth) });
  } catch (e) {
    throw new CodexUsageReadError(`endpoint unreachable: ${errorMessage(e)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new CodexUsageReadError(`HTTP ${res.status}: ${safeErrorDetail({ text })}`);
  }
  const parsed = WireUsageSchema.safeParse(JsonTextSchema.safeParse(text).data);
  if (!parsed.success) {
    throw new CodexUsageReadError("endpoint returned an unexpected body shape (withheld)");
  }
  const wire = parsed.data;

  return {
    accountId: wire.account_id,
    email: wire.email ?? null,
    planType: wire.plan_type ?? null,
    hasCredits: wire.credits?.has_credits ?? null,
    bankedReset: (wire.rate_limit_reset_credits?.available_count ?? 0) > 0 ? { grant: null } : undefined,
    windows: [
      ...toWindows(wire.rate_limit, null, at),
      ...(wire.additional_rate_limits ?? []).flatMap((row) => toWindows(row.rate_limit, row.limit_name, at)),
    ],
  };
}

const RESET_URL = env("TOKENMAXXING_CODEX_RESET_URL", "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
const RESET_DEADLINE_MS = 25_000;
const ConsumeResponseSchema = z.looseObject({ code: z.string() });

export async function consumeCodexReset(auth: CodexAuthJson): Promise<ResetClaim> {
  const res = await http.post(RESET_URL, {
    headers: codexHeaders(auth),
    json: { redeem_request_id: crypto.randomUUID() },
    signal: AbortSignal.timeout(RESET_DEADLINE_MS),
  });
  const text = await res.text();
  if (!res.ok) return { reset: false, detail: `HTTP ${res.status}: ${safeErrorDetail({ text })}` };
  const code = ConsumeResponseSchema.safeParse(JsonTextSchema.safeParse(text).data).data?.code;
  return { reset: code === "reset", detail: code ?? "unreadable body" };
}

const LIMIT_LABEL_ABBREVIATIONS = new Map([["reserve", "rsrv"]]);

export function codexLimitLabel(limitName: string): string {
  const tokens = familyTokens(limitName).filter((t) => Number.isNaN(Number(t)));
  const label = tokens.at(-1) ?? limitName.trim().toLowerCase();
  return LIMIT_LABEL_ABBREVIATIONS.get(label) ?? label;
}
