import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { codexAuthJsonFor, codexPaths, codexStoreDirFor } from "./paths.ts";
import { readJsonFile } from "./state.ts";
import { CodexAuthJsonSchema, ErrnoSchema, type CodexAuthJson } from "./types.ts";

const CodexAuthFileSchema = z
  .looseObject({ tokens: z.unknown().optional() })
  .transform((auth) => (auth.tokens === undefined || auth.tokens === null ? null : auth))
  .pipe(CodexAuthJsonSchema.nullable());

export function readCodexAuthAt(input: { path: string }): CodexAuthJson | null {
  try {
    return readJsonFile(input.path, CodexAuthFileSchema);
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return null;
    throw e;
  }
}

export function readCodexStoreAuth(accountId: string): CodexAuthJson | null {
  return readCodexAuthAt({ path: codexAuthJsonFor(accountId) });
}

export function codexStoreUsable(accountId: string): boolean {
  try {
    return readCodexStoreAuth(accountId) != null;
  } catch {
    return false;
  }
}

export function writeCodexStoreAuth(accountId: string, auth: CodexAuthJson): void {
  writeFileAtomic(codexAuthJsonFor(accountId), JSON.stringify(CodexAuthJsonSchema.parse(auth), null, 2), 0o600);
}

export function deleteCodexStoreAuth(accountId: string): void {
  rmSync(codexStoreDirFor(accountId), { recursive: true, force: true });
}

export function ensureCodexStoreHome(accountId: string): string {
  const store = codexStoreDirFor(accountId);
  mkdirSync(store, { recursive: true });
  mkdirSync(codexPaths.home, { recursive: true });
  mkdirSync(join(codexPaths.home, "sessions"), { recursive: true });
  for (const name of readdirSync(codexPaths.home)) {
    if (name === "auth.json") continue;
    const target = join(codexPaths.home, name);
    const link = join(store, name);
    if (existsSync(link)) continue;
    try {
      symlinkSync(target, link);
    } catch (e) {
      if (ErrnoSchema.safeParse(e).data?.code !== "EEXIST") throw e;
    }
  }
  return store;
}

const IdClaimsSchema = z.looseObject({
  email: z.string().optional(),
  "https://api.openai.com/auth": z
    .looseObject({
      chatgpt_account_id: z.string().optional(),
      chatgpt_user_id: z.string().optional(),
      user_id: z.string().optional(),
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

function seatIdFor(userId: string, accountId: string): string {
  return new Bun.CryptoHasher("sha256").update(`${userId}__${accountId}`).digest("hex");
}

export function codexSeatIdOf(input: { jwt: string }): string | null {
  try {
    const authClaims = IdClaimsSchema.parse(decodeJwtPayload(input))["https://api.openai.com/auth"];
    const userId = authClaims?.chatgpt_user_id ?? authClaims?.user_id;
    const accountId = authClaims?.chatgpt_account_id;
    return userId && accountId ? seatIdFor(userId, accountId) : null;
  } catch {
    return null;
  }
}

export type CodexIdentity = { id: string; accountId: string; email: string | null; planType: string | null };

export function codexIdentityOf(input: { auth: CodexAuthJson }): CodexIdentity {
  const { auth } = input;
  const claims = IdClaimsSchema.parse(decodeJwtPayload({ jwt: auth.tokens.id_token }));
  const authClaims = claims["https://api.openai.com/auth"];
  const accountId = auth.tokens.account_id ?? authClaims?.chatgpt_account_id;
  if (!accountId) {
    throw new Error("codex credential carries no account id (neither tokens.account_id nor the id_token claim)");
  }
  const userId = authClaims?.chatgpt_user_id ?? authClaims?.user_id;
  if (!userId) {
    throw new Error("codex credential carries no user id (neither chatgpt_user_id nor user_id in the id_token claim)");
  }
  return { id: seatIdFor(userId, accountId), accountId, email: claims.email ?? null, planType: authClaims?.chatgpt_plan_type ?? null };
}

const CODEX_EXPIRY_SKEW_MS = 300_000;

export function isCodexAccessExpiring(input: { auth: CodexAuthJson; now: number }): boolean {
  const { auth, now } = input;
  let exp: number | undefined;
  try {
    exp = JwtNumericClaimsSchema.parse(decodeJwtPayload({ jwt: auth.tokens.access_token })).exp;
  } catch {
    return true;
  }
  if (exp == null) return true;
  return exp * 1000 - now <= CODEX_EXPIRY_SKEW_MS;
}
