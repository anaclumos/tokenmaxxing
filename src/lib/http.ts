import ky from "ky";
import { z } from "zod";

const OAuthErrorBodySchema = z.looseObject({
  error: z.string(),
  error_description: z.string().optional(),
});

const NestedErrorBodySchema = z.looseObject({
  error: z.looseObject({ type: z.string().nullish(), code: z.string().nullish(), message: z.string().nullish() }),
  request_id: z.string().nullish(),
});

const PlainErrorBodySchema = z.looseObject({
  detail: z.string().optional(),
  message: z.string().optional(),
});

type ErrorDetail = { codes: string[]; fields: string[] };

function parseErrorBody(body: unknown): ErrorDetail | null {
  const oauth = OAuthErrorBodySchema.safeParse(body);
  if (oauth.success) return { codes: [oauth.data.error], fields: [oauth.data.error, oauth.data.error_description ?? ""] };
  const nested = NestedErrorBodySchema.safeParse(body);
  if (nested.success) {
    const { type, code, message } = nested.data.error;
    const requestId = nested.data.request_id ? ` (${nested.data.request_id})` : "";
    return { codes: [code, type].filter((c): c is string => c != null), fields: [type ?? "", (message ?? "") + requestId] };
  }
  const plain = PlainErrorBodySchema.safeParse(body);
  if (plain.success) return { codes: [], fields: [plain.data.detail ?? "", plain.data.message ?? ""] };
  return null;
}

export function errorCodes(body: unknown): string[] {
  return parseErrorBody(body)?.codes ?? [];
}

export function safeErrorDetail(body: unknown): string {
  const parsed = parseErrorBody(body);
  if (!parsed) return "(unrecognized error body, content withheld)";
  const detail = parsed.fields.filter((field) => field.length > 0).join(": ");
  return detail.length > 0 ? detail.slice(0, 240) : "(no error detail)";
}

export const http = ky.create({
  timeout: 15_000,
  retry: {
    limit: 2,
    methods: ["get"],
    statusCodes: [429, 500, 502, 503, 504],
    afterStatusCodes: [429, 503],
    maxRetryAfter: 10_000,
    backoffLimit: 3000,
  },
});
