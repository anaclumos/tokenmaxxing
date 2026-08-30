import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { OAuthAccountSchema, type OAuthAccount } from "./types.ts";

const ClaudeJsonSchema = z.record(z.string(), z.unknown());

function readClaudeJson(): Record<string, unknown> {
  if (!existsSync(paths.claudeJson)) return {};
  return ClaudeJsonSchema.parse(JSON.parse(readFileSync(paths.claudeJson, "utf8")));
}

export function readOAuthAccount(): OAuthAccount | null {
  const parsed = OAuthAccountSchema.safeParse(readClaudeJson()["oauthAccount"]);
  return parsed.success ? parsed.data : null;
}

export function isApiKeyMode(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const j = readClaudeJson();
  if (z.string().min(1).safeParse(j["apiKeyHelper"]).success) return true;
  return false;
}

export function swapOAuthAccount(next: OAuthAccount): void {
  const j = readClaudeJson();
  j["oauthAccount"] = next;
  writeFileAtomic(paths.claudeJson, JSON.stringify(j, null, 2) + "\n", 0o600);
}
