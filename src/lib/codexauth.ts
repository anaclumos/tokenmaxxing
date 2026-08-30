import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { codexPaths } from "./paths.ts";
import { CodexAuthJsonSchema, type CodexAuthJson } from "./types.ts";

function isEnoent(e: unknown): boolean {
  return e instanceof Error && "code" in e && e.code === "ENOENT";
}

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

export function deleteParkedCodexAuth(input: { credFile: string }): void {
  rmSync(parkedPath(input), { force: true });
}

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
