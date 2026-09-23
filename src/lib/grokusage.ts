import { z } from "zod";
import { http, safeErrorDetail } from "./http.ts";
import { errorMessage } from "./log.ts";
import { env } from "./paths.ts";
import { JsonTextSchema, type Window } from "./types.ts";

export class GrokUsageReadError extends Error {
  status: number | null;
  constructor(detail: string, status: number | null = null) {
    super(`grok usage read failed: ${detail}`);
    this.name = "GrokUsageReadError";
    this.status = status;
  }
}

export const InstantSchema = z.iso.datetime({ offset: true }).transform((iso) => Date.parse(iso));

const CreditsPeriodSchema = z.looseObject({
  start: InstantSchema,
  end: InstantSchema,
});

const CreditsConfigSchema = z.looseObject({
  currentPeriod: CreditsPeriodSchema,
  creditUsagePercent: z.number(),
});

const CreditsBillingSchema = z.looseObject({
  config: CreditsConfigSchema,
});

export type GrokUsage = { windows: Window[]; at: number };

function usageUrl(): string {
  return env("TOKENMAXXING_GROK_USAGE_URL", "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
}

export async function fetchGrokUsage(input: { token: string; at: number }): Promise<GrokUsage> {
  const { token, at } = input;
  let res: Response;
  try {
    res = await http.get(usageUrl(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "grok",
      },
    });
  } catch (e) {
    throw new GrokUsageReadError(`endpoint unreachable: ${errorMessage(e)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new GrokUsageReadError(`HTTP ${res.status}: ${safeErrorDetail({ text })}`, res.status);
  }
  const parsed = CreditsBillingSchema.safeParse(JsonTextSchema.safeParse(text).data);
  if (!parsed.success) {
    throw new GrokUsageReadError("endpoint returned an unexpected body shape (withheld)");
  }
  const { start, end } = parsed.data.config.currentPeriod;
  return {
    at,
    windows: [
      {
        name: null,
        usedPercentage: parsed.data.config.creditUsagePercent,
        resetsAt: end,
        windowSeconds: end > start ? Math.round((end - start) / 1000) : null,
        sampledAt: at,
      },
    ],
  };
}
