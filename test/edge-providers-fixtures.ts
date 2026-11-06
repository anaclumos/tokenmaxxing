import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function scratchDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `tokenmaxxing-edge-${name}-`));
}

function applyEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function useEnv(vars: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  applyEnv(vars);
  return () => applyEnv(saved);
}

export function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}

export function fakeBin(dir: string, name: string, script: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

export function serve(handler: (req: Request) => Response | Promise<Response>): { base: string; stop: () => void } {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handler });
  return { base: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}

function fakeJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT", kid: "test" })}.${part(payload)}.${Buffer.from("test-signature").toString("base64url")}`;
}

export function codexAuthText(input: { accountId: string; expiresAt: number; refreshToken: string; tag: string }): string {
  const exp = Math.floor(input.expiresAt / 1000);
  const iat = exp - 10 * 86_400;
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: input.accountId, chatgpt_plan_type: "pro", chatgpt_user_id: `user-${input.accountId.slice(0, 8)}` } };
  const email = `${input.accountId.slice(0, 8)}@example.com`;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({ email, email_verified: true, iat, exp, ...claims }),
      access_token: fakeJwt({ iat, exp, jti: input.tag, ...claims, "https://api.openai.com/profile": { email, email_verified: true } }),
      refresh_token: input.refreshToken,
      account_id: input.accountId,
    },
    last_refresh: new Date(iat * 1000).toISOString(),
  });
}
