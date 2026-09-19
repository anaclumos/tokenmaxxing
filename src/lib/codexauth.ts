import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { codexAuthJsonFor, codexPaths, codexStoreDirFor } from "./paths.ts";
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

export function readCodexStoreAuth(accountId: string): CodexAuthJson | null {
  return readCodexAuthAt({ path: codexAuthJsonFor(accountId) });
}

export function writeCodexStoreAuth(accountId: string, auth: CodexAuthJson): void {
  mkdirSync(codexStoreDirFor(accountId), { recursive: true });
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
  let names: string[] = [];
  try {
    names = readdirSync(codexPaths.home);
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return store;
    throw e;
  }
  for (const name of names) {
    if (name === "auth.json") continue;
    const target = join(codexPaths.home, name);
    const link = join(store, name);
    if (existsSync(link)) {
      try {
        if (lstatSync(link).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      continue;
    }
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

export type CodexIdentity = { accountId: string; email: string | null; planType: string | null };

export function codexIdentityOf(input: { auth: CodexAuthJson }): CodexIdentity {
  const { auth } = input;
  const claims = IdClaimsSchema.parse(decodeJwtPayload({ jwt: auth.tokens.id_token }));
  const authClaims = claims["https://api.openai.com/auth"];
  const accountId = auth.tokens.account_id ?? authClaims?.chatgpt_account_id;
  if (!accountId) {
    throw new Error("codex credential carries no account id (neither tokens.account_id nor the id_token claim)");
  }
  return { accountId, email: claims.email ?? null, planType: authClaims?.chatgpt_plan_type ?? null };
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
