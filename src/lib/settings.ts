// Idempotent merge of tokenmaxxing's three entries into the user-owned
// ~/.claude/settings.json: our statusLine, a Stop hook, a SessionStart hook.
// Hooks APPEND to existing arrays; the statusLine slot is ours outright -
// tokenmaxxing renders it natively, so any other statusLine command is replaced.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";

/** Absolute path to the installed tokenmaxxing binary the settings entries call. */
export function installedBin(): string {
  return join(paths.binDir, "tokenmaxxing");
}

const HookCmdSchema = z.looseObject({ type: z.string(), command: z.string() });
const HookGroupSchema = z.looseObject({ matcher: z.string().optional(), hooks: z.array(HookCmdSchema).default([]) });
const StatusLineSchema = z.looseObject({ type: z.string(), command: z.string() });
const SettingsSchema = z.looseObject({
  statusLine: StatusLineSchema.optional(),
  hooks: z.record(z.string(), z.array(HookGroupSchema)).optional(),
});
type Settings = z.infer<typeof SettingsSchema>;
type HookGroup = z.infer<typeof HookGroupSchema>;

const SUBCMD = {
  statusline: "__statusline",
  stop: "__stop-hook",
  sessionStart: "__session-start",
} as const;

function readSettings(): Settings {
  if (!existsSync(paths.claudeSettings)) return {};
  return SettingsSchema.parse(JSON.parse(readFileSync(paths.claudeSettings, "utf8")));
}

function writeSettings(s: Settings): void {
  writeFileAtomic(paths.claudeSettings, JSON.stringify(s, null, 2) + "\n", 0o644);
}

/** True if a hook/statusline command string is one tokenmaxxing installed. */
export function isOurCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return (
    cmd.includes(SUBCMD.statusline) ||
    cmd.includes(SUBCMD.stop) ||
    cmd.includes(SUBCMD.sessionStart) ||
    // also match the installed bin path even if the subcommand text changes
    cmd.includes(installedBin())
  );
}

function ourHookGroup(sub: string): HookGroup {
  return { hooks: [{ type: "command", command: `${JSON.stringify(installedBin())} ${sub}` }] };
}

function appendHook(s: Settings, event: string, sub: string): void {
  s.hooks ??= {};
  s.hooks[event] ??= [];
  const arr = s.hooks[event]!;
  const present = arr.some((g) => g.hooks?.some((h) => h.command?.includes(sub)));
  if (!present) arr.push(ourHookGroup(sub));
}

function removeHook(s: Settings, event: string, sub: string): void {
  const arr = s.hooks?.[event];
  if (!arr) return;
  s.hooks![event] = arr.filter((g) => !g.hooks?.some((h) => h.command?.includes(sub)));
  if (s.hooks![event]!.length === 0) delete s.hooks![event];
}

/** Install the three entries: take the statusLine slot, append our hooks. */
export function installSettings(): void {
  const s = readSettings();
  s.statusLine = {
    type: "command",
    command: `${JSON.stringify(installedBin())} ${SUBCMD.statusline}`,
  };
  appendHook(s, "Stop", SUBCMD.stop);
  appendHook(s, "SessionStart", SUBCMD.sessionStart);
  writeSettings(s);
}

/** Remove our three entries. The statusLine slot is deleted only if it is ours. */
export function uninstallSettings(): void {
  const s = readSettings();
  removeHook(s, "Stop", SUBCMD.stop);
  removeHook(s, "SessionStart", SUBCMD.sessionStart);
  if (s.statusLine && isOurCommand(s.statusLine.command)) delete s.statusLine;
  writeSettings(s);
}

const SettingsCheckSchema = z.object({
  statusLineOk: z.boolean(),
  stopOk: z.boolean(),
  sessionStartOk: z.boolean(),
});
export type SettingsCheck = z.infer<typeof SettingsCheckSchema>;

export function checkSettings(): SettingsCheck {
  const s = readSettings();
  const has = (event: string, sub: string) =>
    !!s.hooks?.[event]?.some((g) => g.hooks?.some((h) => h.command?.includes(sub)));
  return {
    statusLineOk: isOurCommand(s.statusLine?.command),
    stopOk: has("Stop", SUBCMD.stop),
    sessionStartOk: has("SessionStart", SUBCMD.sessionStart),
  };
}
