import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { http, safeErrorDetail } from "./http.ts";
import { errorMessage } from "./log.ts";
import { env } from "./paths.ts";
import { JsonTextSchema } from "./types.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";
const CLIENT_SECRET_PREFIX = "GOCSPX-";
const DISCOVERY_CARRY = 128;
const MIN_CLIENT_ID_LENGTH = 40;
const MIN_CLIENT_SECRET_LENGTH = 20;

const CONSUMER_CLIENT_ID_HASH = "bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea";
const CONSUMER_CLIENT_SECRET_HASHES = [
  "1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60",
  "23d89fc5fbce73ed5b9e0cf0ca786bd0eb1bcdff8f65d03dc022d299ad2234b6",
];
const GCP_CLIENT_ID_HASH = "69dee430c4e956f6b672b99a846566d6a86814999fc3b3b050697c0d65ea80c3";
const GCP_CLIENT_SECRET_HASH = "a2ddedc84850a9c48b7e01d61700848083bf0e10fb8d6c99c496803e8b48ced0";

export class AgyRefreshFailedError extends Error {
  constructor(detail: string) {
    super(`Antigravity token refresh failed: ${detail}`);
    this.name = "AgyRefreshFailedError";
  }
}

const RefreshResponseSchema = z.looseObject({
  access_token: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

type OAuthPair = { clientId: string; clientSecret: string };

let cachedConsumer: OAuthPair | null | undefined;
let cachedGcp: OAuthPair | null | undefined;

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSecretChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x5f;
}

function isClientIdChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x2d;
}

function collectCandidates(chunk: Uint8Array, ids: Set<string>, secrets: Set<string>): void {
  const text = Buffer.from(chunk);
  for (let offset = 0; ; ) {
    const index = text.indexOf(CLIENT_SECRET_PREFIX, offset);
    if (index < 0) break;
    const start = index;
    let end = start + CLIENT_SECRET_PREFIX.length;
    while (end < text.length && isSecretChar(text[end]!)) end++;
    let run = text.subarray(start, end);
    if (run.length > DISCOVERY_CARRY) run = run.subarray(0, DISCOVERY_CARRY);
    for (let length = MIN_CLIENT_SECRET_LENGTH; length <= run.length; length++) {
      secrets.add(run.subarray(0, length).toString("utf8"));
    }
    offset = end;
  }
  for (let offset = 0; ; ) {
    const suffixStart = text.indexOf(CLIENT_ID_SUFFIX, offset);
    if (suffixStart < 0) break;
    let start = suffixStart;
    while (start > 0 && isClientIdChar(text[start - 1]!)) start--;
    let run = text.subarray(start, suffixStart);
    if (run.length > DISCOVERY_CARRY) run = run.subarray(run.length - DISCOVERY_CARRY);
    const end = suffixStart + CLIENT_ID_SUFFIX.length;
    for (let length = MIN_CLIENT_ID_LENGTH; length <= run.length; length++) {
      ids.add(`${run.subarray(run.length - length).toString("utf8")}${CLIENT_ID_SUFFIX}`);
    }
    offset = end;
  }
}

function findPair(ids: Set<string>, secrets: Set<string>, wantedIdHash: string, wantedSecretHashes: string[]): OAuthPair | null {
  let clientId = "";
  for (const candidate of ids) {
    if (hashString(candidate) === wantedIdHash) {
      clientId = candidate;
      break;
    }
  }
  let clientSecret = "";
  for (const candidate of secrets) {
    if (wantedSecretHashes.includes(hashString(candidate))) {
      clientSecret = candidate;
      break;
    }
  }
  return clientId === "" || clientSecret === "" ? null : { clientId, clientSecret };
}

function discoverFromBinary(binPath: string): { consumer: OAuthPair | null; gcp: OAuthPair | null } {
  const bytes = readFileSync(binPath);
  const ids = new Set<string>();
  const secrets = new Set<string>();
  const chunkSize = 1 << 20;
  let carry = new Uint8Array(0);
  for (let offset = 0; offset < bytes.length; ) {
    const next = Math.min(bytes.length, offset + chunkSize);
    const merged = new Uint8Array(carry.length + (next - offset));
    merged.set(carry, 0);
    merged.set(bytes.subarray(offset, next), carry.length);
    collectCandidates(merged, ids, secrets);
    carry = merged.length > DISCOVERY_CARRY ? merged.subarray(merged.length - DISCOVERY_CARRY) : merged;
    offset = next;
  }
  return {
    consumer: findPair(ids, secrets, CONSUMER_CLIENT_ID_HASH, CONSUMER_CLIENT_SECRET_HASHES),
    gcp: findPair(ids, secrets, GCP_CLIENT_ID_HASH, [GCP_CLIENT_SECRET_HASH]),
  };
}

function envPair(gcp: boolean): OAuthPair | null {
  const clientId = env(gcp ? "TOKENMAXXING_AGY_GCP_CLIENT_ID" : "TOKENMAXXING_AGY_CLIENT_ID", "");
  const clientSecret = env(gcp ? "TOKENMAXXING_AGY_GCP_CLIENT_SECRET" : "TOKENMAXXING_AGY_CLIENT_SECRET", "");
  return clientId !== "" && clientSecret !== "" ? { clientId, clientSecret } : null;
}

function oauthPair(gcp: boolean, agyBin: string): OAuthPair {
  const fromEnv = envPair(gcp);
  if (fromEnv != null) return fromEnv;
  if (gcp) {
    if (cachedGcp === undefined) cachedGcp = discoverFromBinary(agyBin).gcp;
    if (cachedGcp == null) throw new AgyRefreshFailedError("no GCP OAuth client configured - set TOKENMAXXING_AGY_GCP_CLIENT_ID and TOKENMAXXING_AGY_GCP_CLIENT_SECRET or pin a real agy binary");
    return cachedGcp;
  }
  if (cachedConsumer === undefined) cachedConsumer = discoverFromBinary(agyBin).consumer;
  if (cachedConsumer == null) throw new AgyRefreshFailedError("no OAuth client discovered from the pinned agy binary - set TOKENMAXXING_AGY_CLIENT_ID and TOKENMAXXING_AGY_CLIENT_SECRET");
  return cachedConsumer;
}

export async function refreshAgyAccessToken(input: { refreshToken: string; authMethod: string; agyBin: string }): Promise<string> {
  const gcp = input.authMethod.toLowerCase() === "gcp";
  const { clientId, clientSecret } = oauthPair(gcp, input.agyBin);
  let res: Response;
  try {
    res = await http.post(TOKEN_URL, {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: input.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
  } catch (e) {
    throw new AgyRefreshFailedError(`endpoint unreachable: ${errorMessage(e)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new AgyRefreshFailedError(`HTTP ${res.status}: ${safeErrorDetail({ text })}`);
  const parsed = RefreshResponseSchema.safeParse(JsonTextSchema.safeParse(text).data);
  if (!parsed.success || parsed.data.error != null) {
    throw new AgyRefreshFailedError(parsed.data?.error_description ?? parsed.data?.error ?? "endpoint returned an unexpected body shape (withheld: may carry tokens)");
  }
  return parsed.data.access_token;
}