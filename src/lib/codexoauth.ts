// The one OAuth call tokenmaxxing makes for codex: the refresh_token grant.
// Verified against openai/codex rust-v0.144.5 (login/src/auth/manager.rs):
// POST auth.openai.com/oauth/token, JSON body {client_id, grant_type,
// refresh_token}, no auth headers. The server ROTATES the refresh token and
// punishes reuse of a superseded one (refresh_token_reused), so every rotation
// must be persisted back into the blob it came from immediately.

import { z } from "zod";
import { http, safeErrorDetail } from "./http.ts";
import { CodexAuthJsonSchema, type CodexAuthJson } from "./types.ts";

const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);
const TOKEN_URL = EnvOverrideSchema.parse(process.env.TOKENMAXXING_CODEX_TOKEN_URL) ?? "https://auth.openai.com/oauth/token";
const CLIENT_ID = EnvOverrideSchema.parse(process.env.TOKENMAXXING_CODEX_CLIENT_ID) ?? "app_EMoamEEZ73f0CkXaXp7hrann";

/** Refresh token dead, superseded, or revoked: mark needs-reauth and move on. */
export class CodexInvalidGrantError extends Error {
  constructor(detail: string) {
    super(`codex invalid grant: ${detail}`);
    this.name = "CodexInvalidGrantError";
  }
}

/** The refresh could not run (endpoint unreachable, throttled, drifted body):
 *  an operational miss to retry later, NOT a dead grant and NOT a bug. */
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

/**
 * Exchange the blob's refresh token for fresh tokens. Returns a NEW auth.json
 * value with rotated token material and last_refresh restamped; every sibling
 * field rides along verbatim. Throws CodexInvalidGrantError on a dead grant.
 * Error paths only ever surface response-body snippets, never request headers.
 */
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
