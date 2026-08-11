// Claude Code permission-mode vocabulary for the relay worker, plus the Codex
// sandbox / ask-for-approval mapping. Host terms only: never invent alternate
// security labels. `manual` aliases Claude's `default` (≥2.1.200 UI name).

import { z } from "zod";

export const ClaudePermissionModes = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;

export const ClaudePermissionModeSchema = z.enum(ClaudePermissionModes);
export type ClaudePermissionMode = z.infer<typeof ClaudePermissionModeSchema>;

const AliasSchema = z.enum(["manual", "yolo", "dangerous"]);

/** Parse a host/CLI permission-mode token into a Claude mode. */
export function parsePermissionMode(input: { raw: string }): ClaudePermissionMode {
  const trimmed = input.raw.trim();
  const alias = AliasSchema.safeParse(trimmed);
  if (alias.success) {
    if (alias.data === "manual") return "default";
    return "bypassPermissions";
  }
  return ClaudePermissionModeSchema.parse(trimmed);
}

export function tryParsePermissionMode(input: { raw: string }): ClaudePermissionMode | null {
  try {
    return parsePermissionMode(input);
  } catch {
    return null;
  }
}

export type CodexAskForApproval = "untrusted" | "on-failure" | "on-request" | "never";

export type CodexSpawnFlags = {
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  askForApproval: CodexAskForApproval;
};

/** Map a Claude permission-mode name onto Codex CLI flags. */
export function codexFlagsForMode(input: { mode: ClaudePermissionMode }): CodexSpawnFlags {
  switch (input.mode) {
    case "plan":
    case "default":
      return { sandbox: "read-only", askForApproval: "on-request" };
    case "acceptEdits":
      return { sandbox: "workspace-write", askForApproval: "on-request" };
    case "auto":
      return { sandbox: "workspace-write", askForApproval: "on-request" };
    case "dontAsk":
      return { sandbox: "read-only", askForApproval: "never" };
    case "bypassPermissions":
      return { sandbox: "danger-full-access", askForApproval: "never" };
  }
}

/** Claude argv fragment for a permission mode (includes allow-dangerously when needed). */
export function claudeArgvForMode(input: { mode: ClaudePermissionMode }): string[] {
  const args = ["--permission-mode", input.mode];
  if (input.mode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  }
  return args;
}

/** Codex argv fragment for a Claude-named mode. */
export function codexArgvForMode(input: { mode: ClaudePermissionMode }): string[] {
  const flags = codexFlagsForMode(input);
  return ["--sandbox", flags.sandbox, "--ask-for-approval", flags.askForApproval];
}

/** Under bypassPermissions, worker permission pings must not surface to main. */
export function permissionPingsEnabled(input: { mode: ClaudePermissionMode }): boolean {
  return input.mode !== "bypassPermissions";
}
