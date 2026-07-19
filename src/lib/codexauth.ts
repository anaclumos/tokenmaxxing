// Read/write codex credential blobs ($CODEX_HOME/auth.json and parked copies)
// and decode the id_token's identity claims. Codex has NO cross-process lock on
// auth.json (its refresh serialization is an in-process semaphore, verified
// rust-v0.144.5 manager.rs), so every mutation here runs under tokenmaxxing's
// own codex flock, held by the caller.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { codexPaths } from "./paths.ts";
import { CodexAuthJsonSchema, type CodexAuthJson } from "./types.ts";

function isEnoent(e: unknown): boolean {
  return e instanceof Error && "code" in e && e.code === "ENOENT";
}

/** auth.json at an explicit path (the live file, or an onboard dir's), or null
 *  when absent. Throws on a present-but-unparsable file: that is drift to
 *  surface, not to paper over. One valid-but-unpoolable state maps to null
 *  instead of throwing: `codex login --with-api-key` writes auth.json with
 *  `tokens` OMITTED (serde skip_serializing_if, verified rust-v0.144.5) - the
 *  real binary runs fine on it, so the shim and status must too, and with no
 *  ChatGPT tokens there is nothing tokenmaxxing can pool (closing-review
 *  catch). */
export function readCodexAuthAt(input: { path: string }): CodexAuthJson | null {
  let raw: string;
  try {
    raw = readFileSync(input.path, "utf8");
  } catch (e) {
    if (isEnoent(e)) return null;
    throw e;
  }
  const parsed = JSON.parse(raw);
  const probe = z.looseObject({ tokens: z.unknown().optional() }).parse(parsed);
  if (probe.tokens === undefined || probe.tokens === null) return null;
  return CodexAuthJsonSchema.parse(parsed);
}

/** The live auth.json, or null when codex has no login here. */
export function readLiveCodexAuth(): CodexAuthJson | null {
  return readCodexAuthAt({ path: codexPaths.authJson });
}

export function writeLiveCodexAuth(input: { auth: CodexAuthJson }): void {
  writeFileAtomic(codexPaths.authJson, JSON.stringify(CodexAuthJsonSchema.parse(input.auth), null, 2), 0o600);
}

function parkedPath(input: { credFile: string }): string {
  return join(codexPaths.credsDir, `${input.credFile}.json`);
}

export function readParkedCodexAuth(input: { credFile: string }): CodexAuthJson | null {
  let raw: string;
  try {
    raw = readFileSync(parkedPath(input), "utf8");
  } catch (e) {
    if (isEnoent(e)) return null;
    throw e;
  }
  return CodexAuthJsonSchema.parse(JSON.parse(raw));
}

export function writeParkedCodexAuth(input: { credFile: string; auth: CodexAuthJson }): void {
  writeFileAtomic(parkedPath(input), JSON.stringify(CodexAuthJsonSchema.parse(input.auth), null, 2), 0o600);
}

/** Identity claims inside the id_token JWT payload (verified against a live
 *  0.144.4 token: the chatgpt fields sit under the api.openai.com/auth claim). */
const IdClaimsSchema = z.looseObject({
  email: z.string().optional(),
  "https://api.openai.com/auth": z
    .looseObject({
      chatgpt_account_id: z.string().optional(),
      chatgpt_plan_type: z.string().optional(),
    })
    .optional(),
});

const JwtNumericClaimsSchema = z.looseObject({ exp: z.number().optional() });

function decodeJwtPayload(input: { jwt: string }): unknown {
  const segments = input.jwt.split(".");
  if (segments.length !== 3) throw new Error("not a JWT: expected three dot-separated segments");
  const payload = Buffer.from(segments[1]!, "base64url").toString("utf8");
  return JSON.parse(payload);
}

const CodexIdentitySchema = z.object({
  accountId: z.string(),
  email: z.string().nullable(),
  planType: z.string().nullable(),
});
export type CodexIdentity = z.infer<typeof CodexIdentitySchema>;

/**
 * The blob's own identity, from its token material alone (no network): the
 * explicit tokens.account_id, else the id_token's chatgpt_account_id claim.
 * Parking MUST key on this (or the usage endpoint's echo of it), never on a
 * stored label - labels drift, tokens cannot lie.
 */
export function codexIdentityOf(input: { auth: CodexAuthJson }): CodexIdentity {
  const { auth } = input;
  const claims = IdClaimsSchema.parse(decodeJwtPayload({ jwt: auth.tokens.id_token }));
  const authClaims = claims["https://api.openai.com/auth"];
  const accountId = auth.tokens.account_id ?? authClaims?.chatgpt_account_id;
  if (!accountId) {
    throw new Error("codex credential carries no account id (neither tokens.account_id nor the id_token claim)");
  }
  return CodexIdentitySchema.parse({
    accountId,
    email: claims.email ?? null,
    planType: authClaims?.chatgpt_plan_type ?? null,
  });
}

/** True when the access token is within `skewMs` of its JWT exp (or exp is
 *  unreadable). Codex's own proactive refresh margin is 5 minutes; matching it
 *  means we never install a token codex would immediately refresh. */
export function isCodexAccessExpiring(input: { auth: CodexAuthJson; skewMs?: number; now?: number }): boolean {
  const { auth, skewMs = 300_000, now = Date.now() } = input;
  let exp: number | undefined;
  try {
    exp = JwtNumericClaimsSchema.parse(decodeJwtPayload({ jwt: auth.tokens.access_token })).exp;
  } catch {
    return true;
  }
  if (exp == null) return true;
  return exp * 1000 - now <= skewMs;
}
