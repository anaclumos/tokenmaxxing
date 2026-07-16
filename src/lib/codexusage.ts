// The free codex usage read (user decision 2026-07-16: the direct GET, the same
// HTTP call the codex CLI makes for its own /status). One authed GET returns
// BOTH the token's true identity (account_id/email/plan: the codex analog of
// the claude roles endpoint) and every rate-limit window. No inference runs and
// no session window starts.
//
// Response shape pinned against a live read 2026-07-16: windows carry
// used_percent + reset_at (epoch SECONDS) + limit_window_seconds, the weekly
// window is PRIMARY on plans whose 5h window was removed (July 2026), and
// per-model caps arrive as additional_rate_limits[] rows keyed by limit_name.
// Classification is therefore duration-driven, never position-driven.

import { z } from "zod";
import { http, safeErrorDetail } from "./http.ts";
import { CodexUsageSchema, type CodexAuthJson, type CodexUsage, type CodexWindow } from "./types.ts";
import { codexIdentityOf } from "./codexauth.ts";
import { familyTokens } from "./usage.ts";

const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);
const USAGE_URL = EnvOverrideSchema.parse(process.env.TOKENMAXXING_CODEX_USAGE_URL) ?? "https://chatgpt.com/backend-api/wham/usage";

/** The usage read could not complete (endpoint unreachable, HTTP failure,
 *  drifted body): an operational miss to fall back on cached figures for,
 *  NOT a bug to swallow. */
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

/**
 * One free usage read for the credential in `auth`. Throws on HTTP failure
 * (401 included: the caller decides whether to refresh and retry); error
 * text carries only a response-body snippet, never request headers.
 */
export async function fetchCodexUsage(input: { auth: CodexAuthJson }): Promise<CodexUsage> {
  const { auth } = input;
  const identity = codexIdentityOf({ auth });
  let res: Response;
  try {
    res = await http.get(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.tokens.access_token}`,
        "ChatGPT-Account-Id": identity.accountId,
        "User-Agent": "codex-cli",
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new CodexUsageReadError(`endpoint unreachable: ${message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new CodexUsageReadError(`HTTP ${res.status}: ${safeErrorDetail({ text })}`);
  }
  const parsed = WireUsageSchema.safeParse((() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })());
  if (!parsed.success) {
    throw new CodexUsageReadError("endpoint returned an unexpected body shape (withheld)");
  }
  const wire = parsed.data;

  const perLimit: Record<string, CodexWindow[]> = {};
  for (const row of wire.additional_rate_limits ?? []) {
    const windows = toWindows(row.rate_limit);
    if (windows.length > 0) perLimit[row.limit_name] = windows;
  }

  return CodexUsageSchema.parse({
    accountId: wire.account_id,
    email: wire.email ?? null,
    planType: wire.plan_type ?? null,
    aggregate: toWindows(wire.rate_limit),
    perLimit,
  });
}

/** Quota-chart label for an additional_rate_limits row: the model family,
 *  lowercase ("GPT-5.3-Codex-Spark" -> "spark"). Wire names are versioned, so
 *  the label is derived structurally (last non-numeric token), never by exact
 *  string (user rule 2026-07-17: chart names are lowercase, e.g. "spark"). */
export function codexLimitLabel(input: { limitName: string }): string {
  const tokens = familyTokens(input.limitName).filter((t) => Number.isNaN(Number(t)));
  return tokens.at(-1) ?? input.limitName.trim().toLowerCase();
}

const SESSION_WINDOW_MAX_S = 6 * 3600;

/** A window's screening bar: short windows (5h-class) screen at the session
 *  bar, everything else (weekly aggregates and per-model caps) at the weekly
 *  bar. An unknown duration is treated as weekly: the strictest reading. */
export function isSessionWindow(input: { window: CodexWindow }): boolean {
  const seconds = input.window.windowSeconds;
  return seconds != null && seconds <= SESSION_WINDOW_MAX_S;
}

/** The account's weekly aggregate window: the longest-duration aggregate row. */
export function weeklyWindowOf(input: { aggregate: CodexWindow[] }): CodexWindow | null {
  let best: CodexWindow | null = null;
  for (const window of input.aggregate) {
    if (isSessionWindow({ window })) continue;
    if (best == null || (window.windowSeconds ?? 0) > (best.windowSeconds ?? 0)) best = window;
  }
  return best;
}
