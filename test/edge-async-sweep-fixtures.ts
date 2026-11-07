import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Account } from "../src/lib/types.ts";
import { barrier, claudeCredentials, claudeUsageBody, HOUR_MS, installFakeClaude } from "./fixtures.ts";
import { childEnv, freshHomes, type Homes } from "./edge-telemetry-fixtures.ts";

type Kind = "claude-usage" | "codex-usage" | "other";

type Stub = { base: string; seen: { kind: Kind }[]; stop: () => void };

const DAY_MS = 24 * HOUR_MS;

function kindOf(req: Request): Kind {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/api/oauth/usage")) return "claude-usage";
  if (path.startsWith("/backend-api/wham/usage")) return "codex-usage";
  return "other";
}

export function startStub(input: { gated: readonly Kind[] }): Stub {
  const gate = barrier(input.gated);
  const seen: { kind: Kind }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const kind = kindOf(req);
      seen.push({ kind });
      if (input.gated.includes(kind)) await gate.arrive(kind);
      return answer(kind);
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, seen, stop: () => void server.stop(true) };
}

function codexUsageBody(now: number): unknown {
  const s = Math.floor(now / 1000);
  return {
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_after_seconds: 7200, reset_at: s + 7200 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 4 * 86_400, reset_at: s + 4 * 86_400 },
    },
    credits: { has_credits: false, unlimited: false, balance: "0" },
    additional_rate_limits: [],
    rate_limit_reset_credits: { available_count: 0 },
  };
}

function answer(kind: Kind): Response {
  const now = Date.now();
  if (kind === "claude-usage") return Response.json(claudeUsageBody(now));
  if (kind === "codex-usage") return Response.json(codexUsageBody(now));
  return Response.json({});
}

export function preparedHomes(): Homes {
  const homes = freshHomes();
  installFakeClaude(homes.state);
  const configPath = join(homes.state, "config.json");
  const config: Record<string, unknown> = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...config, telemetry: false }));
  return homes;
}

export function stubEnv(homes: Homes, base: string): Record<string, string> {
  return childEnv(homes, base, {
    CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined,
    CLAUDE_CONFIG_DIR: undefined,
    CODEX_HOME: undefined,
    GROK_HOME: undefined,
    KIMI_CODE_HOME: undefined,
    VIBE_HOME: undefined,
    PI_CODING_AGENT_DIR: undefined,
    NO_COLOR: "1",
    TOKENMAXXING_OAUTH_USAGE_URL: `${base}/api/oauth/usage`,
    TOKENMAXXING_OAUTH_PROFILE_URL: `${base}/api/oauth/profile`,
    TOKENMAXXING_CODEX_USAGE_URL: `${base}/backend-api/wham/usage`,
    TOKENMAXXING_CODEX_RESET_URL: `${base}/backend-api/wham/rate-limit-reset-credits/consume`,
    TOKENMAXXING_OPENROUTER_URL: `${base}/openrouter/api`,
    TOKENMAXXING_GROK_USAGE_URL: `${base}/grok/usage`,
    TOKENMAXXING_CURSOR_API_URL: `${base}/cursor`,
    TOKENMAXXING_MUSE_USAGE_URL: `${base}/muse/usage`,
  });
}

function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
}

export function writeClaudePool(homes: Homes, accounts: Account[]): void {
  writeFileSync(join(homes.state, "accounts.json"), JSON.stringify({ version: 2, accounts }));
}

export function writeClaudeStore(homes: Homes, id: string, token: string): void {
  writePrivate(join(homes.state, "stores", id.slice(0, 8), ".credentials.json"), claudeCredentials(token, Date.now() + 30 * DAY_MS));
}

function fakeJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT", kid: "test" })}.${part(payload)}.${Buffer.from("test-signature").toString("base64url")}`;
}

export function writeCodexPool(homes: Homes, accounts: Account[]): void {
  writeFileSync(join(homes.state, "codex-accounts.json"), JSON.stringify({ version: 2, accounts }));
}

export function writeCodexStore(homes: Homes, id: string): void {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 10 * 86_400;
  const auth = { "https://api.openai.com/auth": { chatgpt_account_id: id, chatgpt_plan_type: "pro", chatgpt_user_id: `user-${id.slice(0, 8)}` } };
  const tokens = {
    id_token: fakeJwt({ email: `${id}@example.com`, email_verified: true, iat, exp, ...auth }),
    access_token: fakeJwt({ iat, exp, ...auth, "https://api.openai.com/profile": { email: `${id}@example.com`, email_verified: true } }),
    refresh_token: `rt-${id}`,
    account_id: id,
  };
  writePrivate(join(homes.state, "codex-stores", id.slice(0, 8), "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens, last_refresh: new Date().toISOString() }));
}

export function logTail(homes: Homes): string {
  const path = join(homes.state, "tokenmaxxing.log");
  return existsSync(path) ? readFileSync(path, "utf8").slice(-3000) : "";
}

export function parseJson(text: string): Record<string, unknown> | null {
  try {
    const doc: Record<string, unknown> = JSON.parse(text);
    return doc;
  } catch {
    return null;
  }
}
