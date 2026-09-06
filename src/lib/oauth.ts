import { z } from "zod";
import { http, oauthErrorCode, safeErrorDetail } from "./http.ts";
import { ProfileResponseSchema, RefreshResponseSchema, TokenIdentitySchema, type OAuthCreds, type TokenIdentity } from "./types.ts";

const EnvOverrideSchema = z.string().min(1).optional().catch(undefined);
const TOKEN_URL = EnvOverrideSchema.parse(process.env.TOKENMAXXING_OAUTH_TOKEN_URL) ?? "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = EnvOverrideSchema.parse(process.env.TOKENMAXXING_OAUTH_CLIENT_ID) ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const PROFILE_URL = EnvOverrideSchema.parse(process.env.TOKENMAXXING_OAUTH_PROFILE_URL) ?? "https://api.anthropic.com/api/oauth/profile";

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

export class RefreshRejectedError extends Error {
  constructor(public readonly status: number, public readonly detail: string) {
    super(`token refresh rejected (HTTP ${status}): ${detail}`);
    this.name = "RefreshRejectedError";
  }
}

export class IdentityUnavailableError extends Error {
  constructor(public readonly status: number | null, public readonly detail: string) {
    super(status == null ? `profile endpoint unreachable: ${detail}` : `identity check failed (HTTP ${status}): ${detail}`);
    this.name = "IdentityUnavailableError";
  }
}

export function isDeadCredential(creds: OAuthCreds): boolean {
  return creds.refreshToken === "" || creds.accessToken === "";
}

export async function refreshCredential(creds: OAuthCreds, now = Date.now()): Promise<OAuthCreds> {
  if (isDeadCredential(creds)) throw new InvalidGrantError("credential was cleared after a failed refresh");
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
    const detail = safeErrorDetail({ text });
    if (res.status === 400 && oauthErrorCode({ text }) === "invalid_grant") throw new InvalidGrantError(detail);
    if (res.status >= 400 && res.status < 500) throw new RefreshRejectedError(res.status, detail);
    throw new Error(`token refresh failed (HTTP ${res.status}): ${detail}`);
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

export async function fetchTokenIdentity(accessToken: string): Promise<TokenIdentity> {
  let res: Response;
  try {
    res = await http.get(PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    });
  } catch (e) {
    throw new IdentityUnavailableError(null, e instanceof Error ? e.message : String(e));
  }
  const text = await res.text();
  if (!res.ok) throw new IdentityUnavailableError(res.status, safeErrorDetail({ text }));
  const parsed = ProfileResponseSchema.safeParse((() => {
    try { return JSON.parse(text); } catch { return null; }
  })());
  if (!parsed.success) throw new IdentityUnavailableError(res.status, `profile endpoint returned an unrecognized body (${text.length} bytes, withheld)`);
  return TokenIdentitySchema.parse({
    accountUuid: parsed.data.account.uuid,
    email: parsed.data.account.email ?? null,
    organizationUuid: parsed.data.organization.uuid,
    organizationName: parsed.data.organization.name ?? null,
  });
}

export function describeIdentity(id: TokenIdentity): string {
  return `${id.email ?? id.organizationName ?? "unknown"} (account ${id.accountUuid.slice(0, 8)})`;
}
