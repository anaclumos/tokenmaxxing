import ky from "ky";
import { z } from "zod";

const OAuthErrorBodySchema = z.looseObject({
  error: z.string(),
  error_description: z.string().optional(),
});

const NestedErrorBodySchema = z.looseObject({
  error: z.looseObject({ type: z.string().optional(), message: z.string().optional() }),
  request_id: z.string().nullish(),
});

const PlainErrorBodySchema = z.looseObject({
  detail: z.string().optional(),
  message: z.string().optional(),
});

const ErrorDetailSchema = z.object({ code: z.string().nullable(), fields: z.array(z.string()) });
type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

function parseErrorBody(text: string): ErrorDetail | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const oauth = OAuthErrorBodySchema.safeParse(json);
  if (oauth.success) return { code: oauth.data.error, fields: [oauth.data.error, oauth.data.error_description ?? ""] };
  const nested = NestedErrorBodySchema.safeParse(json);
  if (nested.success) {
    const requestId = nested.data.request_id ? ` (${nested.data.request_id})` : "";
    return { code: nested.data.error.type ?? null, fields: [nested.data.error.type ?? "", (nested.data.error.message ?? "") + requestId] };
  }
  const plain = PlainErrorBodySchema.safeParse(json);
  if (plain.success) return { code: null, fields: [plain.data.detail ?? "", plain.data.message ?? ""] };
  return null;
}

export function oauthErrorCode(input: { text: string }): string | null {
  return parseErrorBody(input.text)?.code ?? null;
}

export function safeErrorDetail(input: { text: string }): string {
  const body = parseErrorBody(input.text);
  if (!body) return `(unrecognized error body, ${input.text.length} bytes, content withheld)`;
  const detail = body.fields.filter((field) => field.length > 0).join(": ");
  return detail.length > 0 ? detail.slice(0, 240) : "(no error detail)";
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
