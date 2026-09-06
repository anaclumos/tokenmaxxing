import { z } from "zod";
import { paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { readJson } from "./json.ts";
import { OAuthAccountSchema, type OAuthAccount } from "./types.ts";

const ClaudeJsonSchema = z.record(z.string(), z.unknown());

function readClaudeJson(): Record<string, unknown> {
  return readJson(paths.claudeJson, ClaudeJsonSchema) ?? {};
}

export function readOAuthAccount(): OAuthAccount | null {
  return OAuthAccountSchema.nullish().parse(readClaudeJson()["oauthAccount"]) ?? null;
}

export function isApiKeyMode(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  return z.string().min(1).safeParse(readClaudeJson()["apiKeyHelper"]).success;
}

export function swapOAuthAccount(next: OAuthAccount): void {
  const j = readClaudeJson();
  j["oauthAccount"] = next;
  writeFileAtomic(paths.claudeJson, JSON.stringify(j, null, 2) + "\n", 0o600);
}
