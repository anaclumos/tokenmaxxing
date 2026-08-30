import { z } from "zod";
import { http, safeErrorDetail } from "./http.ts";
import { RefreshResponseSchema, RolesResponseSchema, type OAuthCreds, type RolesResponse } from "./types.ts";

const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);
const TOKEN_URL = EnvOverrideSchema.parse(process.env.TOKENMAXXING_OAUTH_TOKEN_URL) ?? "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = EnvOverrideSchema.parse(process.env.TOKENMAXXING_OAUTH_CLIENT_ID) ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ROLES_URL = EnvOverrideSchema.parse(process.env.TOKENMAXXING_OAUTH_ROLES_URL) ?? "https://api.anthropic.com/api/oauth/claude_cli/roles";

const DEFAULT_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

export class InvalidGrantError extends Error {
  constructor(public readonly detail: string) {
    super(`invalid_grant: ${detail}`);
    this.name = "InvalidGrantError";
  }
}

export async function refreshCredential(creds: OAuthCreds, now = Date.now()): Promise<OAuthCreds> {
  const scope = (creds.scopes?.length ? creds.scopes : DEFAULT_SCOPES).join(" ");
  const body = {
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: CLIENT_ID,
    scope,
  };

  let res: Response;
  try {
    res = await http.post(TOKEN_URL, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`token endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 400 && /invalid_grant/.test(text)) {
      throw new InvalidGrantError(safeErrorDetail({ text }));
    }
    throw new Error(`token refresh failed (HTTP ${res.status}): ${safeErrorDetail({ text })}`);
  }

  const parsed = RefreshResponseSchema.safeParse((() => {
    try { return JSON.parse(text); } catch { return null; }
  })());
  if (!parsed.success) {
    throw new Error(`token endpoint returned an unrecognized body (${text.length} bytes, withheld)`);
  }
  const json = parsed.data;

  const expiresIn = json.expires_in ?? 8 * 3600;
  const refreshExpiresIn = json.refresh_token_expires_in;

  return {
    ...creds,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? creds.refreshToken,
    expiresAt: now + expiresIn * 1000,
    refreshTokenExpiresAt:
      refreshExpiresIn != null ? now + refreshExpiresIn * 1000 : creds.refreshTokenExpiresAt,
    scopes: json.scope ? json.scope.split(" ").filter(Boolean) : creds.scopes,
  };
}

export function isAccessTokenExpiring(creds: OAuthCreds, skewMs = 120_000, now = Date.now()): boolean {
  return !creds.expiresAt || creds.expiresAt - now <= skewMs;
}

export async function fetchTokenOrg(accessToken: string): Promise<RolesResponse> {
  let res: Response;
  try {
    res = await http.get(ROLES_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
    });
  } catch (e) {
    throw new Error(`roles endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`roles check failed (HTTP ${res.status}): ${safeErrorDetail({ text })}`);
  const parsed = RolesResponseSchema.safeParse((() => {
    try { return JSON.parse(text); } catch { return null; }
  })());
  if (!parsed.success) throw new Error(`roles endpoint returned an unrecognized body (${text.length} bytes, withheld)`);
  return parsed.data;
}
