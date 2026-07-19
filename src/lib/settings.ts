// Idempotent merge of tokenmaxxing's entries into the user-owned
// ~/.claude/settings.json: our statusLine + subagentStatusLine, a Stop hook,
// a SessionStart hook. Hooks APPEND to existing arrays; the statusLine slots
// are ours outright - tokenmaxxing renders them natively, so any other
// statusLine command is replaced.

import { existsSync, readFileSync, statSync } from "node:fs";
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
  subagentStatusLine: StatusLineSchema.optional(),
  hooks: z.record(z.string(), z.array(HookGroupSchema)).optional(),
});
type Settings = z.infer<typeof SettingsSchema>;
type HookGroup = z.infer<typeof HookGroupSchema>;

const SUBCMD = {
  statusline: "__statusline",
  subagentStatusline: "__subagent-statusline",
  stop: "__stop-hook",
  sessionStart: "__session-start",
} as const;

function readSettings(): Settings {
  if (!existsSync(paths.claudeSettings)) return {};
  return SettingsSchema.parse(JSON.parse(readFileSync(paths.claudeSettings, "utf8")));
}

function writeSettings(s: Settings): void {
  // Preserve the user's mode: settings.json can carry an env block with
  // credentials, and the atomic rename would otherwise widen a 0600 file to
  // world-readable. A brand-new file starts at the conservative 0600.
  const mode = existsSync(paths.claudeSettings) ? statSync(paths.claudeSettings).mode & 0o777 : 0o600;
  writeFileAtomic(paths.claudeSettings, JSON.stringify(s, null, 2) + "\n", mode);
}

/** True if a hook/statusline command string is one tokenmaxxing installed. */
function isOurCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return (
    cmd.includes(SUBCMD.statusline) ||
    cmd.includes(SUBCMD.subagentStatusline) ||
    cmd.includes(SUBCMD.stop) ||
    cmd.includes(SUBCMD.sessionStart) ||
    // also match the installed bin path even if the subcommand text changes
    cmd.includes(installedBin())
  );
}

/** The exact command string installSettings writes for a subcommand; doctor
 *  compares against it verbatim, so a green check proves the canonical entry. */
function ourCommand(sub: string): string {
  return `${JSON.stringify(installedBin())} ${sub}`;
}

function ourHookGroup(sub: string): HookGroup {
  return { hooks: [{ type: "command", command: ourCommand(sub) }] };
}

function appendHook(s: Settings, event: string, sub: string): void {
  s.hooks ??= {};
  s.hooks[event] ??= [];
  const arr = s.hooks[event]!;
  const present = arr.some((g) => g.hooks.some((h) => h.command === ourCommand(sub)));
  if (!present) arr.push(ourHookGroup(sub));
}

/** True only for a command tokenmaxxing itself wrote - the exact historical
 *  shape `"<...>/tokenmaxxing" <sub>` at ANY install path (so stale
 *  pre-relocation entries match too). A foreign command that merely mentions
 *  the subcommand or the path as text is NOT ours and must survive removal. */
function isOurHookCommand(cmd: string, sub: string): boolean {
  if (!cmd.endsWith(` ${sub}`)) return false;
  const quotedPath = cmd.slice(0, cmd.length - (sub.length + 1));
  if (!quotedPath.startsWith('"') || !quotedPath.endsWith('"')) return false;
  let path: unknown;
  try {
    path = JSON.parse(quotedPath);
  } catch {
    return false;
  }
  const parsed = z.string().safeParse(path);
  return parsed.success && parsed.data.endsWith("/tokenmaxxing");
}

function removeHook(s: Settings, event: string, sub: string): void {
  const arr = s.hooks?.[event];
  if (!arr) return;
  // Strip only VERIFIED tokenmaxxing-owned entries from WITHIN each group:
  // foreign hooks sharing a group - or merely mentioning our strings - survive
  // (review catches, PR #31), and a group is dropped only once it is empty.
  for (const g of arr) g.hooks = g.hooks.filter((h) => !isOurHookCommand(h.command, sub));
  s.hooks![event] = arr.filter((g) => g.hooks.length > 0);
  if (s.hooks![event]!.length === 0) delete s.hooks![event];
}

/** Install the entries: take both statusLine slots, append our hooks. Stale
 *  same-subcommand hooks from an OLD install path are dropped first, so a
 *  TOKENMAXXING_HOME relocation rewrites the entries instead of leaving dead
 *  paths that read as installed (relocation residue is how the supervisor
 *  recursion incident started). Foreign hooks are untouched. */
export function installSettings(): void {
  const s = readSettings();
  s.statusLine = { type: "command", command: ourCommand(SUBCMD.statusline) };
  s.subagentStatusLine = { type: "command", command: ourCommand(SUBCMD.subagentStatusline) };
  removeHook(s, "Stop", SUBCMD.stop);
  removeHook(s, "SessionStart", SUBCMD.sessionStart);
  appendHook(s, "Stop", SUBCMD.stop);
  appendHook(s, "SessionStart", SUBCMD.sessionStart);
  writeSettings(s);
}

/** Remove our entries. The statusLine slots are deleted only if they are ours. */
export function uninstallSettings(): void {
  const s = readSettings();
  removeHook(s, "Stop", SUBCMD.stop);
  removeHook(s, "SessionStart", SUBCMD.sessionStart);
  if (s.statusLine && isOurCommand(s.statusLine.command)) delete s.statusLine;
  if (s.subagentStatusLine && isOurCommand(s.subagentStatusLine.command)) delete s.subagentStatusLine;
  writeSettings(s);
}

const SettingsCheckSchema = z.object({
  statusLineOk: z.boolean(),
  subagentStatusLineOk: z.boolean(),
  stopOk: z.boolean(),
  sessionStartOk: z.boolean(),
});
export type SettingsCheck = z.infer<typeof SettingsCheckSchema>;

export function checkSettings(): SettingsCheck {
  const s = readSettings();
  // Exact-command identity (review catch, PR #31): only the verbatim string
  // installSettings writes counts as installed. A hook pointing at an OLD
  // install path reads as broken, and a foreign command that merely mentions
  // the path or subcommand as text never green-lights.
  const has = (event: string, sub: string) =>
    !!s.hooks?.[event]?.some((g) => g.hooks.some((h) => h.command === ourCommand(sub)));
  return {
    statusLineOk: s.statusLine?.command === ourCommand(SUBCMD.statusline),
    subagentStatusLineOk: s.subagentStatusLine?.command === ourCommand(SUBCMD.subagentStatusline),
    stopOk: has("Stop", SUBCMD.stop),
    sessionStartOk: has("SessionStart", SUBCMD.sessionStart),
  };
}
