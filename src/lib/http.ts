import ky from "ky";
import { z } from "zod";

const ErrorBodySchema = z.looseObject({
  error: z.string().optional(),
  error_description: z.string().optional(),
  detail: z.string().optional(),
  message: z.string().optional(),
});

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
