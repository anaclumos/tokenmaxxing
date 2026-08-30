import { z } from "zod";
import { http, safeErrorDetail } from "./http.ts";
import { CodexAuthJsonSchema, type CodexAuthJson } from "./types.ts";

const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);
const TOKEN_URL = EnvOverrideSchema.parse(process.env.TOKENMAXXING_CODEX_TOKEN_URL) ?? "https://auth.openai.com/oauth/token";
const CLIENT_ID = EnvOverrideSchema.parse(process.env.TOKENMAXXING_CODEX_CLIENT_ID) ?? "app_EMoamEEZ73f0CkXaXp7hrann";

export class CodexInvalidGrantError extends Error {
  constructor(detail: string) {
    super(`codex invalid grant: ${detail}`);
    this.name = "CodexInvalidGrantError";
  }
}

export class CodexRefreshFailedError extends Error {
  constructor(detail: string) {
    super(`codex token refresh failed: ${detail}`);
    this.name = "CodexRefreshFailedError";
  }
}

const CodexRefreshResponseSchema = z.looseObject({
  id_token: z.string().optional(),
  access_token: z.string(),
  refresh_token: z.string().optional(),
});

const DEAD_GRANT_MARKERS = [
  "invalid_grant",
  "refresh_token_reused",
  "refresh_token_expired",
  "refresh_token_invalidated",
];

export async function refreshCodexAuth(input: { auth: CodexAuthJson; now?: number }): Promise<CodexAuthJson> {
  const { auth, now = Date.now() } = input;
  let res: Response;
  try {
    res = await http.post(TOKEN_URL, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: auth.tokens.refresh_token,
      }),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new CodexRefreshFailedError(`endpoint unreachable: ${message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    const detail = safeErrorDetail({ text });
    if (DEAD_GRANT_MARKERS.some((marker) => text.includes(marker))) {
      throw new CodexInvalidGrantError(detail);
    }
    throw new CodexRefreshFailedError(`HTTP ${res.status}: ${detail}`);
  }

  const parsed = CodexRefreshResponseSchema.safeParse((() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })());
  if (!parsed.success) {
    throw new CodexRefreshFailedError("endpoint returned an unexpected body shape (withheld: may carry tokens)");
  }

  return CodexAuthJsonSchema.parse({
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: parsed.data.access_token,
      refresh_token: parsed.data.refresh_token ?? auth.tokens.refresh_token,
      id_token: parsed.data.id_token ?? auth.tokens.id_token,
    },
    last_refresh: new Date(now).toISOString(),
  });
}
