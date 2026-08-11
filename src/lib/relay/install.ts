// relay install: write thin host agent templates + optional hook snippets.
// Merge only tokenmaxxing-owned keys.

import { existsSync, mkdirSync, readFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import { paths } from "../paths.ts";
import { isOurHookCommand } from "../settings.ts";

const pluginRoot = () => join(import.meta.dir, "../../../agent-plugin");

function repoAgentsDir(): string {
  return join(pluginRoot(), "agents");
}

function repoSkillDir(): string {
  return join(pluginRoot(), "skills", "relay-session");
}

function repoHooksDir(): string {
  return join(pluginRoot(), "hooks");
}

export type InstallTarget = "cursor" | "claude" | "all";

export type InstallResult = {
  agentsWritten: string[];
  skillWritten: boolean;
  hooksMerged: string[];
};

function copyAgent(input: { name: string; destDir: string }): string {
  mkdirSync(input.destDir, { recursive: true });
  const src = join(repoAgentsDir(), input.name);
  const dest = join(input.destDir, input.name);
  if (!existsSync(src)) throw new Error(`missing agent template: ${src}`);
  cpSync(src, dest);
  return dest;
}

function copySkill(input: { destDir: string }): boolean {
  const src = repoSkillDir();
  if (!existsSync(src)) return false;
  mkdirSync(input.destDir, { recursive: true });
  cpSync(src, input.destDir, { recursive: true });
  return true;
}

const CursorHooksSchema = z.looseObject({
  version: z.number().optional(),
  hooks: z.record(z.string(), z.unknown()).optional(),
});

const TOKENMAXXING_HOOK_KEY = "tokenmaxxingRelay";

/** Merge Cursor hooks.json: only the tokenmaxxingRelay key is ours. */
export function mergeCursorHooks(input: { hooksPath: string }): boolean {
  const snippetPath = join(repoHooksDir(), "cursor-relay.json");
  if (!existsSync(snippetPath)) return false;
  const snippet = CursorHooksSchema.parse(JSON.parse(readFileSync(snippetPath, "utf8")));
  let existing: z.infer<typeof CursorHooksSchema> = { version: 1, hooks: {} };
  if (existsSync(input.hooksPath)) {
    try {
      existing = CursorHooksSchema.parse(JSON.parse(readFileSync(input.hooksPath, "utf8")));
    } catch {
      existing = { version: 1, hooks: {} };
    }
  }
  existing.hooks ??= {};
  const ours = snippet.hooks?.[TOKENMAXXING_HOOK_KEY];
  if (ours === undefined) return false;
  existing.hooks[TOKENMAXXING_HOOK_KEY] = ours;
  mkdirSync(dirname(input.hooksPath), { recursive: true });
  writeFileAtomic(input.hooksPath, JSON.stringify(existing, null, 2) + "\n");
  return true;
}

const ClaudeSettingsLoose = z.looseObject({
  hooks: z.record(z.string(), z.array(z.looseObject({
    matcher: z.string().optional(),
    hooks: z.array(z.looseObject({ type: z.string(), command: z.string() })).default([]),
  }))).optional(),
});

const RELAY_PERM_SUB = "__relay-permission-hook";

/** Append PermissionRequest hook for relay; never remove foreign hooks. */
export function mergeClaudeRelayPermissionHook(input: { settingsPath?: string } = {}): boolean {
  const settingsPath = input.settingsPath ?? paths.claudeSettings;
  const bin = join(paths.binDir, "tokenmaxxing");
  const command = `${JSON.stringify(bin)} ${RELAY_PERM_SUB}`;
  let settings: z.infer<typeof ClaudeSettingsLoose> = {};
  if (existsSync(settingsPath)) {
    settings = ClaudeSettingsLoose.parse(JSON.parse(readFileSync(settingsPath, "utf8")));
  }
  settings.hooks ??= {};
  settings.hooks.PermissionRequest ??= [];
  const arr = settings.hooks.PermissionRequest;
  const present = arr.some((g) => g.hooks.some((h) => h.command === command || isOurHookCommand(h.command, RELAY_PERM_SUB)));
  if (!present) {
    arr.push({ hooks: [{ type: "command", command }] });
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  const mode = existsSync(settingsPath) ? 0o600 : 0o600;
  writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n", mode);
  return true;
}

export function installRelayHosts(input: {
  target: InstallTarget;
  cursorAgentsDir?: string;
  claudeAgentsDir?: string;
  cursorHooksPath?: string;
  mergeHooks?: boolean;
}): InstallResult {
  const home = process.env.HOME ?? "";
  const cursorAgents = input.cursorAgentsDir ?? join(home, ".cursor", "agents");
  const claudeAgents = input.claudeAgentsDir ?? join(home, ".claude", "agents");
  const agentsWritten: string[] = [];
  const hooksMerged: string[] = [];
  let skillWritten = false;

  if (input.target === "cursor" || input.target === "all") {
    agentsWritten.push(copyAgent({ name: "tokenmaxxing-claude.md", destDir: cursorAgents }));
    agentsWritten.push(copyAgent({ name: "tokenmaxxing-codex.md", destDir: cursorAgents }));
    skillWritten = copySkill({ destDir: join(home, ".cursor", "skills", "relay-session") }) || skillWritten;
    if (input.mergeHooks !== false) {
      const hooksPath = input.cursorHooksPath ?? join(home, ".cursor", "hooks.json");
      if (mergeCursorHooks({ hooksPath })) hooksMerged.push(hooksPath);
    }
  }
  if (input.target === "claude" || input.target === "all") {
    agentsWritten.push(copyAgent({ name: "tokenmaxxing-claude.md", destDir: claudeAgents }));
    agentsWritten.push(copyAgent({ name: "tokenmaxxing-codex.md", destDir: claudeAgents }));
    if (input.mergeHooks !== false) {
      if (mergeClaudeRelayPermissionHook()) hooksMerged.push(paths.claudeSettings);
    }
  }
  return { agentsWritten, skillWritten, hooksMerged };
}

export { RELAY_PERM_SUB };
