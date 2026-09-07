import { HTTPError, NetworkError, TimeoutError } from "ky";
import { z } from "zod";
import { errorMessage } from "./errors.ts";
import { http, safeErrorDetail } from "./http.ts";
import { envOverride } from "./paths.ts";
import type { CodexAuthJson, CodexUsage, CodexWindow } from "./types.ts";
import { codexIdentityOf } from "./codexauth.ts";
import { familyTokens } from "./usage.ts";

const USAGE_URL = envOverride("TOKENMAXXING_CODEX_USAGE_URL") ?? "https://chatgpt.com/backend-api/wham/usage";

export class CodexUsageReadError extends Error {
  constructor(detail: string) {
    super(`codex usage read failed: ${detail}`);
    this.name = "CodexUsageReadError";
  }
}

const WireWindowSchema = z.looseObject({
  used_percent: z.number(),
  limit_window_seconds: z.number().nullish(),
  reset_at: z.number().nullish(),
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
  additional_rate_limits: z
    .array(z.looseObject({ limit_name: z.string(), rate_limit: WireRateLimitSchema.nullish() }))
    .nullish(),
});

const UNEXPECTED_BODY = "endpoint returned an unexpected body shape (withheld)";

function toWindows(rateLimit: z.infer<typeof WireRateLimitSchema> | null | undefined): CodexWindow[] {
  const out: CodexWindow[] = [];
  for (const wire of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    if (wire == null) continue;
    out.push({
      usedPercentage: wire.used_percent,
      resetsAt: wire.reset_at != null ? wire.reset_at * 1000 : null,
      windowSeconds: wire.limit_window_seconds ?? null,
    });
  }
  return out;
}

export async function fetchCodexUsage(input: { auth: CodexAuthJson }): Promise<CodexUsage> {
  const { auth } = input;
  const identity = codexIdentityOf({ auth });
  let body: unknown;
  try {
    body = await http
      .get(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${auth.tokens.access_token}`,
          "ChatGPT-Account-Id": identity.accountId,
          "User-Agent": "codex-cli",
        },
      })
      .json();
  } catch (e) {
    if (e instanceof HTTPError) throw new CodexUsageReadError(`HTTP ${e.response.status}: ${safeErrorDetail(e.data)}`);
    if (e instanceof NetworkError || e instanceof TimeoutError) throw new CodexUsageReadError(`endpoint unreachable: ${errorMessage(e)}`);
    throw new CodexUsageReadError(UNEXPECTED_BODY);
  }
  const parsed = WireUsageSchema.safeParse(body);
  if (!parsed.success) throw new CodexUsageReadError(UNEXPECTED_BODY);
  const wire = parsed.data;

  const perLimit: Record<string, CodexWindow[]> = {};
  for (const row of wire.additional_rate_limits ?? []) {
    const windows = toWindows(row.rate_limit);
    if (windows.length > 0) perLimit[row.limit_name] = windows;
  }

  return {
    accountId: wire.account_id,
    email: wire.email ?? null,
    planType: wire.plan_type ?? null,
    aggregate: toWindows(wire.rate_limit),
    perLimit,
  };
}

const LIMIT_LABEL_ABBREVIATIONS = new Map([["reserve", "rsrv"]]);

export function codexLimitLabel(input: { limitName: string }): string {
  const tokens = familyTokens(input.limitName).filter((t) => Number.isNaN(Number(t)));
  const label = tokens.at(-1) ?? input.limitName.trim().toLowerCase();
  return LIMIT_LABEL_ABBREVIATIONS.get(label) ?? label;
}

const SESSION_WINDOW_MAX_S = 6 * 3600;

export function isSessionWindow(input: { window: CodexWindow }): boolean {
  const seconds = input.window.windowSeconds;
  return seconds != null && seconds <= SESSION_WINDOW_MAX_S;
}

export function weeklyWindowOf(input: { aggregate: CodexWindow[] }): CodexWindow | null {
  let best: CodexWindow | null = null;
  for (const window of input.aggregate) {
    if (isSessionWindow({ window })) continue;
    if (best == null || (window.windowSeconds ?? 0) > (best.windowSeconds ?? 0)) best = window;
  }
  return best;
}
