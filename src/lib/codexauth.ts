import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { codexStoreDirFor } from "./paths.ts";
import { CodexAuthJsonSchema, ErrnoSchema, type CodexAuthJson } from "./types.ts";

export function readCodexAuthAt(input: { path: string }): CodexAuthJson | null {
  let raw: string;
  try {
    raw = readFileSync(input.path, "utf8");
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return null;
    throw e;
  }
  const parsed = JSON.parse(raw);
  const probe = z.looseObject({ tokens: z.unknown().optional() }).parse(parsed);
  if (probe.tokens === undefined || probe.tokens === null) return null;
  return CodexAuthJsonSchema.parse(parsed);
}

export function codexStoreAuthPath(accountId: string): string {
  return join(codexStoreDirFor(accountId), "auth.json");
}

export function readCodexStore(accountId: string): CodexAuthJson | null {
  return readCodexAuthAt({ path: codexStoreAuthPath(accountId) });
}

export function writeCodexStore(accountId: string, auth: CodexAuthJson): void {
  mkdirSync(codexStoreDirFor(accountId), { recursive: true, mode: 0o700 });
  writeFileAtomic(codexStoreAuthPath(accountId), JSON.stringify(CodexAuthJsonSchema.parse(auth), null, 2), 0o600);
}

export function deleteCodexStore(accountId: string): void {
  rmSync(codexStoreDirFor(accountId), { recursive: true, force: true });
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
