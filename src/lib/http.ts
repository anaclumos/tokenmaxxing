// Shared HTTP client. Sampling every account at once, or swapping right at a
// limit, can trip an endpoint's burst throttle, so GETs retry a bounded number
// of times, honoring the server's Retry-After (capped). throwHttpErrors is off
// so callers read the body and shape their own fail-fast error; retry still runs.

import ky from "ky";
import { z } from "zod";

/** The error-shape fields OAuth/usage endpoints legitimately explain themselves
 *  with. Error bodies are NEVER surfaced raw: a token endpoint's failure body
 *  can echo request material, so anything outside this allowlist is dropped. */
const ErrorBodySchema = z.looseObject({
  error: z.string().optional(),
  error_description: z.string().optional(),
  detail: z.string().optional(),
  message: z.string().optional(),
});

/** Allowlisted, token-safe rendering of an HTTP error body. */
export function safeErrorDetail(input: { text: string }): string {
  const parsed = ErrorBodySchema.safeParse((() => {
    try {
      return JSON.parse(input.text);
    } catch {
      return null;
    }
  })());
  if (!parsed.success) return "(unparsable error body withheld)";
  const fields = [parsed.data.error, parsed.data.error_description, parsed.data.detail, parsed.data.message];
  const detail = fields.filter((field): field is string => field != null && field.length > 0).join(": ");
  return detail.length > 0 ? detail.slice(0, 200) : "(no error detail)";
}

export const http = ky.create({
  timeout: 15_000,
  throwHttpErrors: false,
  retry: {
    limit: 2,
    methods: ["get"],
    statusCodes: [429, 500, 502, 503, 504],
    afterStatusCodes: [429, 503],
    maxRetryAfter: 10_000,
    backoffLimit: 3000,
  },
});
