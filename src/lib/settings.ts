import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";

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
  stopFailure: "__stop-failure-hook",
  sessionStart: "__session-start",
} as const;

const STOP_FAILURE_MATCHER = "rate_limit";

function readSettings(): Settings {
  if (!existsSync(paths.claudeSettings)) return {};
  return SettingsSchema.parse(JSON.parse(readFileSync(paths.claudeSettings, "utf8")));
}

function writeSettings(s: Settings): void {
  const mode = existsSync(paths.claudeSettings) ? statSync(paths.claudeSettings).mode & 0o777 : 0o600;
  writeFileAtomic(paths.claudeSettings, JSON.stringify(s, null, 2) + "\n", mode);
}

function isOurCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return (
    cmd.includes(SUBCMD.statusline) ||
    cmd.includes(SUBCMD.subagentStatusline) ||
    cmd.includes(SUBCMD.stop) ||
    cmd.includes(SUBCMD.stopFailure) ||
    cmd.includes(SUBCMD.sessionStart) ||
    cmd.includes(installedBin())
  );
}

function ourCommand(sub: string): string {
  return `${JSON.stringify(installedBin())} ${sub}`;
}

function ourHookGroup(sub: string, matcher?: string): HookGroup {
  return { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: ourCommand(sub) }] };
}

function appendHook(s: Settings, event: string, sub: string, matcher?: string): void {
  s.hooks ??= {};
  s.hooks[event] ??= [];
  const arr = s.hooks[event]!;
  const present = arr.some((g) => g.hooks.some((h) => h.command === ourCommand(sub)));
  if (!present) arr.push(ourHookGroup(sub, matcher));
}

export function isOurHookCommand(cmd: string, sub: string): boolean {
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
  for (const g of arr) g.hooks = g.hooks.filter((h) => !isOurHookCommand(h.command, sub));
  s.hooks![event] = arr.filter((g) => g.hooks.length > 0);
  if (s.hooks![event]!.length === 0) delete s.hooks![event];
}

export function installSettings(): void {
  const s = readSettings();
  s.statusLine = { type: "command", command: ourCommand(SUBCMD.statusline) };
  s.subagentStatusLine = { type: "command", command: ourCommand(SUBCMD.subagentStatusline) };
  removeHook(s, "Stop", SUBCMD.stop);
  removeHook(s, "StopFailure", SUBCMD.stopFailure);
  removeHook(s, "SessionStart", SUBCMD.sessionStart);
  appendHook(s, "Stop", SUBCMD.stop);
  appendHook(s, "StopFailure", SUBCMD.stopFailure, STOP_FAILURE_MATCHER);
  appendHook(s, "SessionStart", SUBCMD.sessionStart);
  writeSettings(s);
}

export function uninstallSettings(): void {
  const s = readSettings();
  removeHook(s, "Stop", SUBCMD.stop);
  removeHook(s, "StopFailure", SUBCMD.stopFailure);
  removeHook(s, "SessionStart", SUBCMD.sessionStart);
  if (s.statusLine && isOurCommand(s.statusLine.command)) delete s.statusLine;
  if (s.subagentStatusLine && isOurCommand(s.subagentStatusLine.command)) delete s.subagentStatusLine;
  writeSettings(s);
}

const SettingsCheckSchema = z.object({
  statusLineOk: z.boolean(),
  subagentStatusLineOk: z.boolean(),
  stopOk: z.boolean(),
  stopFailureOk: z.boolean(),
  sessionStartOk: z.boolean(),
});
export type SettingsCheck = z.infer<typeof SettingsCheckSchema>;

export function checkSettings(): SettingsCheck {
  const s = readSettings();
  const has = (event: string, sub: string, matcher?: string) =>
    !!s.hooks?.[event]?.some((g) => (matcher === undefined || g.matcher === matcher) && g.hooks.some((h) => h.command === ourCommand(sub)));
  return {
    statusLineOk: s.statusLine?.command === ourCommand(SUBCMD.statusline),
    subagentStatusLineOk: s.subagentStatusLine?.command === ourCommand(SUBCMD.subagentStatusline),
    stopOk: has("Stop", SUBCMD.stop),
    stopFailureOk: has("StopFailure", SUBCMD.stopFailure, STOP_FAILURE_MATCHER),
    sessionStartOk: has("SessionStart", SUBCMD.sessionStart),
  };
}
