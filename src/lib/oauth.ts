import { HTTPError, NetworkError, TimeoutError } from "ky";
import { errorMessage } from "./errors.ts";
import { errorCodes, http, safeErrorDetail } from "./http.ts";
import { envOverride } from "./paths.ts";
import { ProfileResponseSchema, RefreshResponseSchema, type OAuthCreds, type TokenIdentity } from "./types.ts";

const TOKEN_URL = envOverride("TOKENMAXXING_OAUTH_TOKEN_URL") ?? "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = envOverride("TOKENMAXXING_OAUTH_CLIENT_ID") ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const PROFILE_URL = envOverride("TOKENMAXXING_OAUTH_PROFILE_URL") ?? "https://api.anthropic.com/api/oauth/profile";

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
  const scope = (creds.scopes.length > 0 ? creds.scopes : DEFAULT_SCOPES).join(" ");
  let body: unknown;
  try {
    body = await http.post(TOKEN_URL, { json: { grant_type: "refresh_token", refresh_token: creds.refreshToken, client_id: CLIENT_ID, scope } }).json();
  } catch (e) {
    if (e instanceof HTTPError) {
      const status = e.response.status;
      const detail = safeErrorDetail(e.data);
      if (status === 400 && errorCodes(e.data).includes("invalid_grant")) throw new InvalidGrantError(detail);
      if (status < 500) throw new RefreshRejectedError(status, detail);
      throw new Error(`token refresh failed (HTTP ${status}): ${detail}`);
    }
    if (e instanceof NetworkError || e instanceof TimeoutError) throw new Error(`token endpoint unreachable: ${errorMessage(e)}`);
    throw new Error("token endpoint returned an unrecognized body (withheld)");
  }
  const parsed = RefreshResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("token endpoint returned an unrecognized body (withheld)");
  const json = parsed.data;
  return {
    ...creds,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? creds.refreshToken,
    expiresAt: now + json.expires_in * 1000,
    refreshTokenExpiresAt: json.refresh_token_expires_in != null ? now + json.refresh_token_expires_in * 1000 : creds.refreshTokenExpiresAt,
    scopes: json.scope ? json.scope.split(" ").filter(Boolean) : creds.scopes,
  };
}

export function isAccessTokenExpiring(creds: OAuthCreds, skewMs = 120_000, now = Date.now()): boolean {
  return !creds.expiresAt || creds.expiresAt - now <= skewMs;
}

export async function fetchTokenIdentity(accessToken: string): Promise<TokenIdentity> {
  let res: Response;
  try {
    res = await http.get(PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (e) {
    if (e instanceof HTTPError) throw new IdentityUnavailableError(e.response.status, safeErrorDetail(e.data));
    throw new IdentityUnavailableError(null, errorMessage(e));
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new IdentityUnavailableError(res.status, "profile endpoint returned an unrecognized body (withheld)");
  }
  const parsed = ProfileResponseSchema.safeParse(body);
  if (!parsed.success) throw new IdentityUnavailableError(res.status, "profile endpoint returned an unrecognized body (withheld)");
  return {
    accountUuid: parsed.data.account.uuid,
    email: parsed.data.account.email ?? null,
    organizationUuid: parsed.data.organization.uuid,
    organizationName: parsed.data.organization.name ?? null,
  };
}

export function describeIdentity(id: TokenIdentity): string {
  return `${id.email ?? id.organizationName ?? "unknown"} (account ${id.accountUuid.slice(0, 8)})`;
}
