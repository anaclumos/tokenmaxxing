import { z } from "zod";
import { http, safeErrorDetail } from "./http.ts";
import { CodexUsageSchema, type CodexAuthJson, type CodexUsage, type Window } from "./types.ts";
import { codexIdentityOf } from "./codexauth.ts";
import { familyTokens } from "./usage.ts";

const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);
const USAGE_URL = EnvOverrideSchema.parse(process.env.TOKENMAXXING_CODEX_USAGE_URL) ?? "https://chatgpt.com/backend-api/wham/usage";

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

function toWindows(rateLimit: z.infer<typeof WireRateLimitSchema> | null | undefined, name: string | null, at: number): Window[] {
  const out: Window[] = [];
  for (const wire of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    if (wire == null) continue;
    out.push({
      name,
      usedPercentage: wire.used_percent,
      resetsAt: wire.reset_at != null ? wire.reset_at * 1000 : null,
      windowSeconds: wire.limit_window_seconds ?? null,
      sampledAt: at,
    });
  }
  return out;
}

export async function fetchCodexUsage(input: { auth: CodexAuthJson; at: number }): Promise<CodexUsage> {
  const { auth, at } = input;
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

  return CodexUsageSchema.parse({
    accountId: wire.account_id,
    email: wire.email ?? null,
    planType: wire.plan_type ?? null,
    windows: [
      ...toWindows(wire.rate_limit, null, at),
      ...(wire.additional_rate_limits ?? []).flatMap((row) => toWindows(row.rate_limit, row.limit_name, at)),
    ],
  });
}

const LIMIT_LABEL_ABBREVIATIONS = new Map([["reserve", "rsrv"]]);

export function codexLimitLabel(limitName: string): string {
  const tokens = familyTokens(limitName).filter((t) => Number.isNaN(Number(t)));
  const label = tokens.at(-1) ?? limitName.trim().toLowerCase();
  return LIMIT_LABEL_ABBREVIATIONS.get(label) ?? label;
}
