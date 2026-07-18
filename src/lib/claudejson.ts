// Read/replace the `oauthAccount` identity object in ~/.claude.json.
// We touch ONLY oauthAccount and preserve every other key verbatim.

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

/** Detect API-key / helper auth mode (no poolable subscription credential). */
export function isApiKeyMode(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const j = readClaudeJson();
  // apiKeyHelper is configured in settings, but a persisted flag may appear here too.
  if (z.string().min(1).safeParse(j["apiKeyHelper"]).success) return true;
  return false;
}

/**
 * Atomically replace ONLY oauthAccount, preserving all other keys and their
 * insertion order. Reads fresh from disk so we never clobber concurrent edits
 * to unrelated keys with a stale in-memory copy.
 */
export function swapOAuthAccount(next: OAuthAccount): void {
  const j = readClaudeJson();
  j["oauthAccount"] = next;
  writeFileAtomic(paths.claudeJson, JSON.stringify(j, null, 2) + "\n", 0o600);
}
