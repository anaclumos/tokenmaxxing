// Idempotent merge of tokenmaxxing's three entries into the user-owned
// ~/.claude/settings.json: a statusLine shim, a Stop hook, a SessionStart hook.
// We APPEND to existing hook arrays and WRAP the existing statusLine - never clobber.

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

const PRIOR_STATUSLINE_FILE = join(paths.home, "prior-statusline.json");

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

const InstallResultSchema = z.object({ priorStatusLine: z.string().nullable() });
export type InstallResult = z.infer<typeof InstallResultSchema>;

/**
 * Install the three entries. Returns the prior statusLine command that was
 * wrapped (stored to disk so the shim can chain to it and uninstall can restore).
 */
export function installSettings(): InstallResult {
  const s = readSettings();

  // ---- statusLine: capture prior (unless it's already ours), then wrap.
  let prior: string | null;
  if (s.statusLine && !isOurCommand(s.statusLine.command)) {
    prior = s.statusLine.command;
    writeFileAtomic(PRIOR_STATUSLINE_FILE, JSON.stringify({ command: prior }) + "\n", 0o644);
  } else {
    prior = readPriorStatusLine();
  }
  s.statusLine = {
    type: "command",
    command: `${JSON.stringify(installedBin())} ${SUBCMD.statusline}`,
  };

  // ---- hooks: append ours if absent.
  appendHook(s, "Stop", SUBCMD.stop);
  appendHook(s, "SessionStart", SUBCMD.sessionStart);

  writeSettings(s);
  return { priorStatusLine: prior };
}

/** Remove our three entries and restore the prior statusLine if we have it. */
export function uninstallSettings(): void {
  const s = readSettings();
  removeHook(s, "Stop", SUBCMD.stop);
  removeHook(s, "SessionStart", SUBCMD.sessionStart);
  if (s.statusLine && isOurCommand(s.statusLine.command)) {
    const prior = readPriorStatusLine();
    if (prior) s.statusLine = { type: "command", command: prior };
    else delete s.statusLine;
  }
  writeSettings(s);
}

const PriorStatusLineSchema = z.object({ command: z.string() });

export function readPriorStatusLine(): string | null {
  if (!existsSync(PRIOR_STATUSLINE_FILE)) return null;
  return PriorStatusLineSchema.parse(JSON.parse(readFileSync(PRIOR_STATUSLINE_FILE, "utf8"))).command;
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
