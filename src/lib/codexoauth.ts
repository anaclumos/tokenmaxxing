import { HTTPError, NetworkError, TimeoutError } from "ky";
import { z } from "zod";
import { errorMessage } from "./errors.ts";
import { errorCodes, http, safeErrorDetail } from "./http.ts";
import { envOverride } from "./paths.ts";
import type { CodexAuthJson } from "./types.ts";

const TOKEN_URL = envOverride("TOKENMAXXING_CODEX_TOKEN_URL") ?? "https://auth.openai.com/oauth/token";
const CLIENT_ID = envOverride("TOKENMAXXING_CODEX_CLIENT_ID") ?? "app_EMoamEEZ73f0CkXaXp7hrann";

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

const DEAD_GRANT_CODES = new Set(["invalid_grant", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"]);

const UNEXPECTED_BODY = "endpoint returned an unexpected body shape (withheld: may carry tokens)";

export async function refreshCodexAuth(input: { auth: CodexAuthJson; now?: number }): Promise<CodexAuthJson> {
  const { auth, now = Date.now() } = input;
  let body: unknown;
  try {
    body = await http.post(TOKEN_URL, { json: { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: auth.tokens.refresh_token } }).json();
  } catch (e) {
    if (e instanceof HTTPError) {
      const detail = safeErrorDetail(e.data);
      if (errorCodes(e.data).some((code) => DEAD_GRANT_CODES.has(code))) throw new CodexInvalidGrantError(detail);
      throw new CodexRefreshFailedError(`HTTP ${e.response.status}: ${detail}`);
    }
    if (e instanceof NetworkError || e instanceof TimeoutError) throw new CodexRefreshFailedError(`endpoint unreachable: ${errorMessage(e)}`);
    throw new CodexRefreshFailedError(UNEXPECTED_BODY);
  }
  const parsed = CodexRefreshResponseSchema.safeParse(body);
  if (!parsed.success) throw new CodexRefreshFailedError(UNEXPECTED_BODY);
  return {
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: parsed.data.access_token,
      refresh_token: parsed.data.refresh_token ?? auth.tokens.refresh_token,
      id_token: parsed.data.id_token ?? auth.tokens.id_token,
    },
    last_refresh: new Date(now).toISOString(),
  };
}
