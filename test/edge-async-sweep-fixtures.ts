import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Account, ApiKeysIndex, Window } from "../src/lib/types.ts";
import { account, barrier, claudeCredentials, claudeUsageBody, HOUR_MS, installFakeClaude, SESSION_SECONDS, WEEK_SECONDS } from "./fixtures.ts";
import { childEnv, freshHomes, type Homes } from "./edge-telemetry-fixtures.ts";

export type Kind = "claude-usage" | "claude-profile" | "codex-usage" | "codex-reset" | "openrouter-key" | "other";

export type Seen = { kind: Kind; key: string; method: string; path: string };

export type Stub = { base: string; seen: Seen[]; count: (kind: Kind) => number; stop: () => void };

const DAY_MS = 24 * HOUR_MS;

export function kindOf(req: Request): Kind {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/openrouter/")) return "openrouter-key";
  if (path.startsWith("/api/oauth/profile")) return "claude-profile";
  if (path.startsWith("/api/oauth/usage")) return "claude-usage";
  if (req.method === "POST" && path.startsWith("/backend-api/wham/rate-limit-reset-credits")) return "codex-reset";
  if (path.startsWith("/backend-api/wham/usage")) return "codex-usage";
  return "other";
}

export function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

export function startStub(input: {
  gated?: readonly string[];
  keyOf?: (req: Request, kind: Kind) => string;
  respond?: (kind: Kind, req: Request) => Response;
}): Stub {
  const gated = input.gated ?? [];
  const gate = barrier(gated);
  const seen: Seen[] = [];
  const keyOf = input.keyOf ?? ((_req: Request, kind: Kind) => kind);
  const respond = input.respond ?? answer;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const kind = kindOf(req);
      const key = keyOf(req, kind);
      seen.push({ kind, key, method: req.method, path: new URL(req.url).pathname });
      if (gated.includes(key)) await gate.arrive(key);
      return respond(kind, req);
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    seen,
    count: (kind) => seen.filter((s) => s.kind === kind).length,
    stop: () => void server.stop(true),
  };
}

export function codexUsageBody(now: number): unknown {
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

export const OPENROUTER_REMAINING = 7.25;

export function openRouterKeyBody(): unknown {
  return { data: { label: "sk-or-v1-a1b...9f0", limit: 20, limit_remaining: OPENROUTER_REMAINING, usage: 12.75, is_free_tier: false, rate_limit: { requests: -1, interval: "10s" } } };
}

export function answer(kind: Kind, _req: Request): Response {
  const now = Date.now();
  if (kind === "claude-usage") return Response.json(claudeUsageBody(now));
  if (kind === "codex-usage") return Response.json(codexUsageBody(now));
  if (kind === "codex-reset") return Response.json({ code: "reset" });
  if (kind === "openrouter-key") return Response.json(openRouterKeyBody());
  return Response.json({});
}

export function profileBody(id: string): unknown {
  return {
    account: { uuid: id, email: `${id}@example.com`, full_name: "Test User", display_name: "Test" },
    organization: { uuid: "org-test", name: "Test Org", organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" },
  };
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function pooledClaudeAccount(id: string, windows: Window[] = []): Account {
  return { ...account(id, "max", windows), oauthAccount: { accountUuid: id, emailAddress: `${id}@example.com`, organizationUuid: "org-test" } };
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

export function codexAccountAtWeeklyBar(id: string, now: number): Account {
  const weekly: Window = { name: null, usedPercentage: 100, resetsAt: now + 5 * DAY_MS, windowSeconds: WEEK_SECONDS, sampledAt: now - 60_000 };
  const session: Window = { name: null, usedPercentage: 12, resetsAt: now + 2 * HOUR_MS, windowSeconds: SESSION_SECONDS, sampledAt: now - 60_000 };
  return { ...account(id, "pro", [session, weekly]), lastUsageAt: now - 60_000, bankedReset: { grant: "rate-limit-reset-credit" } };
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

export const OPENROUTER_KEY_ID = "4d7e1a90";

export function writeOpenRouterKey(homes: Homes, now: number): void {
  const index: ApiKeysIndex = {
    version: 1,
    keys: [{ id: OPENROUTER_KEY_ID, label: "router", spentUsd: 0, creditSetAt: now - DAY_MS, addedAt: now - DAY_MS, openrouter: { remainingUsd: 3, at: now - HOUR_MS } }],
    baselines: {},
  };
  writeFileSync(join(homes.state, "api-keys.json"), JSON.stringify(index));
  writePrivate(join(homes.state, "api-keys", OPENROUTER_KEY_ID), `sk-or-v1-${"5c".repeat(32)}`);
}

export function readPool(homes: Homes, file: "accounts.json" | "codex-accounts.json"): Account[] {
  const index: { accounts: Account[] } = JSON.parse(readFileSync(join(homes.state, file), "utf8"));
  return index.accounts;
}

export function readApiKeys(homes: Homes): ApiKeysIndex {
  const index: ApiKeysIndex = JSON.parse(readFileSync(join(homes.state, "api-keys.json"), "utf8"));
  return index;
}

export function unnamedFigures(a: Account | undefined): number[] {
  return (a?.windows ?? []).filter((w) => w.name === null).map((w) => w.usedPercentage).sort((x, y) => x - y);
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
