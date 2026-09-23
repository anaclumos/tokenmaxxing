import { http, safeErrorDetail } from "./http.ts";
import { env } from "./paths.ts";
import { errorMessage } from "./log.ts";
import { JsonTextSchema, ProfileResponseSchema, type OAuthCreds, type TokenIdentity } from "./types.ts";

const PROFILE_URL = env("TOKENMAXXING_OAUTH_PROFILE_URL", "https://api.anthropic.com/api/oauth/profile");

export class InvalidGrantError extends Error {
  constructor(public readonly detail: string) {
    super(`invalid_grant: ${detail}`);
    this.name = "InvalidGrantError";
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

export function claudeTierLabel(input: { subscriptionType?: string; rateLimitTier?: string }): string | null {
  const segments = input.rateLimitTier?.split("_") ?? [];
  const multiplier = segments.find((seg) => seg.length > 1 && seg.endsWith("x") && Number.isInteger(Number(seg.slice(0, -1))));
  if (input.subscriptionType == null) return multiplier ?? null;
  return multiplier ? `${input.subscriptionType} ${multiplier}` : input.subscriptionType;
}

export function isAccessTokenExpiring(creds: OAuthCreds, skewMs = 120_000, now = Date.now()): boolean {
  return !creds.expiresAt || creds.expiresAt - now <= skewMs;
}

export async function fetchTokenIdentity(accessToken: string, signal?: AbortSignal): Promise<TokenIdentity> {
  let res: Response;
  try {
    res = await http.get(PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      signal,
    });
  } catch (e) {
    throw new IdentityUnavailableError(null, errorMessage(e));
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw new IdentityUnavailableError(res.status, `profile response body unreadable: ${errorMessage(e)}`);
  }
  if (!res.ok) throw new IdentityUnavailableError(res.status, safeErrorDetail({ text }));
  const parsed = ProfileResponseSchema.safeParse(JsonTextSchema.safeParse(text).data);
  if (!parsed.success) throw new IdentityUnavailableError(res.status, `profile endpoint returned an unrecognized body (${text.length} bytes, withheld)`);
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
