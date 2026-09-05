import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { escape } from "es-toolkit";
import { z } from "zod";
import { codexPaths, HOME, paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { installedBin, installSettings, isOurHookCommand, uninstallSettings } from "./settings.ts";
import { resolveRealClaude } from "./claudebin.ts";
import { loadConfig } from "./state.ts";

const InstallOutcomeSchema = z.object({
  claudeWrapper: z.string(),
  installedBin: z.string(),
  pathAhead: z.boolean(),
  timerLoaded: z.boolean(),
  checkIntervalS: z.number().int().positive(),
});
export type InstallOutcome = z.infer<typeof InstallOutcomeSchema>;

export function isBinDirAhead(): boolean {
  const dirs = (process.env.PATH ?? "").split(":");
  const ourIdx = dirs.indexOf(paths.binDir);
  if (ourIdx < 0) return false;
  try {
    const realDir = dirname(resolveRealClaude());
    const realIdx = dirs.indexOf(realDir);
    return realIdx < 0 || ourIdx < realIdx;
  } catch {
    return ourIdx >= 0;
  }
}

const EnvFlagSchema = z.enum(["1", "true", "yes"]).optional().catch(undefined);

export function isNixPackaged(): boolean {
  if (EnvFlagSchema.parse(process.env.TOKENMAXXING_NIX) != null) return true;
  try {
    return realpathSync(Bun.main).startsWith("/nix/store/");
  } catch {
    return false;
  }
}

export function skipImperativeTimer(): boolean {
  return EnvFlagSchema.parse(process.env.TOKENMAXXING_SKIP_TIMER) != null;
}

function isNixStorePath(path: string): boolean {
  return path === "/nix/store" || path.startsWith("/nix/store/");
}

function isEacces(e: unknown): boolean {
  return typeof e === "object" && e != null && "code" in e && e.code === "EACCES";
}

function cannotWriteRcTarget(target: string): boolean {
  if (EnvFlagSchema.parse(process.env.TOKENMAXXING_SKIP_SHELL_RC) != null) return true;
  if (isNixStorePath(target)) return true;
  if (!existsSync(target)) return false;
  try {
    accessSync(target, constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

export function managedShellRcSkipLines(): { headline: string; detail: string; exportLine: string } {
  return {
    headline: "shell rc is managed (Home Manager / nix-store) - PATH was not auto-edited",
    detail: `put ${paths.binDir} on PATH via home.sessionPath (programs.tokenmaxxing Home Manager module sets this), e.g.`,
    exportLine: `home.sessionPath = [ "${paths.binDir}" ];`,
  };
}

function nixSupervisorShim(bun: string, entry: string): string {
  return `#!/bin/sh
dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
old_ifs=$IFS
IFS=:
new_path=
for p in $PATH; do
  [ "$p" = "$dir" ] && continue
  if [ -n "$new_path" ]; then new_path="$new_path:$p"; else new_path="$p"; fi
done
IFS=$old_ifs
PATH=$new_path
export PATH
if command -v tokenmaxxing >/dev/null 2>&1; then
  exec tokenmaxxing "$@"
fi
exec ${JSON.stringify(bun)} run ${JSON.stringify(entry)} "$@"
`;
}

export function installSupervisor(): InstallOutcome {
  mkdirSync(paths.binDir, { recursive: true });
  const target = installedBin();
  const entry = realpathSync(Bun.main);
  if (isNixPackaged()) {
    writeFileAtomic(target, nixSupervisorShim(process.execPath, entry), 0o755);
  } else {
    writeFileAtomic(target, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(entry)} "$@"\n`, 0o755);
  }

  writeFileAtomic(paths.supervisorLink, `#!/bin/sh\nexec ${JSON.stringify(target)} __supervise "$@"\n`, 0o755);
  writeFileAtomic(join(paths.binDir, "xx"), `#!/bin/sh\nexec ${JSON.stringify(target)} "$@"\n`, 0o755);

  installSettings();
  const checkIntervalS = Math.ceil(loadConfig().policy.checkIntervalMs / 1000);
  return {
    claudeWrapper: paths.supervisorLink,
    installedBin: target,
    pathAhead: isBinDirAhead(),
    timerLoaded: installCheckTimer(checkIntervalS),
    checkIntervalS,
  };
}

const CodexHookEventsSchema = z.looseObject({
  Stop: z.array(z.looseObject({ hooks: z.array(z.looseObject({ command: z.string().optional() })).default([]) })).default([]),
});
const CodexHooksFileSchema = z.looseObject({
  description: z.string().optional(),
  hooks: CodexHookEventsSchema.default({ Stop: [] }),
});

const CODEX_STOP_HOOK_SUBCOMMAND = "__codex-stop-hook";

function codexStopHookCommand(): string {
  return `${JSON.stringify(installedBin())} ${CODEX_STOP_HOOK_SUBCOMMAND}`;
}

function withoutOurCodexStopHooks(groups: { hooks: { type?: string; command?: string }[] }[]): typeof groups {
  return groups
    .map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !isOurHookCommand(hook.command ?? "", CODEX_STOP_HOOK_SUBCOMMAND)) }))
    .filter((group) => group.hooks.length > 0);
}

export function installCodexStopHook(): void {
  const current = existsSync(codexPaths.hooksJson)
    ? CodexHooksFileSchema.parse(JSON.parse(readFileSync(codexPaths.hooksJson, "utf8")))
    : CodexHooksFileSchema.parse({});
  const next = {
    ...current,
    hooks: {
      ...current.hooks,
      Stop: [
        ...withoutOurCodexStopHooks(current.hooks.Stop),
        { hooks: [{ type: "command", command: codexStopHookCommand(), timeout: 120, statusMessage: "tokenmaxxing switch check" }] },
      ],
    },
  };
  mkdirSync(codexPaths.home, { recursive: true });
  writeFileAtomic(codexPaths.hooksJson, JSON.stringify(next, null, 2) + "\n");
}

export function uninstallCodexStopHook(): void {
  if (!existsSync(codexPaths.hooksJson)) return;
  const current = CodexHooksFileSchema.parse(JSON.parse(readFileSync(codexPaths.hooksJson, "utf8")));
  const next = {
    ...current,
    hooks: {
      ...current.hooks,
      Stop: withoutOurCodexStopHooks(current.hooks.Stop),
    },
  };
  writeFileAtomic(codexPaths.hooksJson, JSON.stringify(next, null, 2) + "\n");
}

export function codexSupervisorLink(): string {
  return join(paths.binDir, "codex");
}

export function installCodexSupervisor(): void {
  mkdirSync(paths.binDir, { recursive: true });
  writeFileAtomic(codexSupervisorLink(), `#!/bin/sh\nexec ${JSON.stringify(installedBin())} __supervise-codex "$@"\n`, 0o755);
  installCodexStopHook();
}

export function uninstallCodexSupervisor(): void {
  uninstallCodexStopHook();
  if (existsSync(codexSupervisorLink())) rmSync(codexSupervisorLink(), { force: true });
}

const LAUNCHD_LABEL = "com.tokenmaxxing.check";

function launchdPlist(): string {
  return join(paths.launchdAgentsDir, `${LAUNCHD_LABEL}.plist`);
}

function launchdDomain(): string | null {
  const uid = process.getuid?.();
  return uid == null ? null : `gui/${uid}`;
}

function run(cmd: string[]): boolean {
  try {
    return Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore", timeout: 10_000 }).exitCode === 0;
  } catch {
    return false;
  }
}

function installCheckTimer(intervalS: number): boolean {
  if (skipImperativeTimer()) return true;

  if (process.platform === "darwin") {
    const plist = launchdPlist();
    writeFileAtomic(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${escape(installedBin())}</string><string>check</string><string>--if-due</string></array>
  <key>StartInterval</key><integer>${intervalS}</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${escape(join(paths.home, "check.stderr.log"))}</string>
</dict>
</plist>
`,
      0o644,
    );
    const domain = launchdDomain();
    if (domain == null) return false;
    run(["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]);
    return run(["launchctl", "bootstrap", domain, plist]) || checkTimerHealthy();
  }

  const exec = `"${installedBin().replaceAll("%", "%%")}" check --if-due`;
  writeFileAtomic(
    join(paths.systemdUserDir, "tokenmaxxing-check.service"),
    `[Unit]
Description=tokenmaxxing account-switch check

[Service]
Type=oneshot
ExecStart=${exec}
`,
    0o644,
  );
  writeFileAtomic(
    join(paths.systemdUserDir, "tokenmaxxing-check.timer"),
    `[Unit]
Description=tokenmaxxing periodic account-switch check

[Timer]
OnBootSec=60
OnUnitActiveSec=${intervalS}
AccuracySec=5

[Install]
WantedBy=timers.target
`,
    0o644,
  );
  return (
    run(["systemctl", "--user", "daemon-reload"]) &&
    run(["systemctl", "--user", "enable", "--now", "tokenmaxxing-check.timer"])
  );
}

export function timerActivationHint(): string {
  if (process.platform === "darwin") {
    return `launchctl bootstrap gui/$(id -u) ${launchdPlist()}`;
  }
  return "systemctl --user daemon-reload && systemctl --user enable --now tokenmaxxing-check.timer";
}

export function checkTimerHealthy(): boolean {
  if (skipImperativeTimer()) return true;
  if (process.platform === "darwin") {
    const domain = launchdDomain();
    return existsSync(launchdPlist()) && domain != null && run(["launchctl", "print", `${domain}/${LAUNCHD_LABEL}`]);
  }
  return (
    existsSync(join(paths.systemdUserDir, "tokenmaxxing-check.timer")) &&
    run(["systemctl", "--user", "is-active", "--quiet", "tokenmaxxing-check.timer"])
  );
}

export function timerDeactivationHint(): string {
  if (process.platform === "darwin") {
    return `launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`;
  }
  return "systemctl --user disable --now tokenmaxxing-check.timer";
}

function launchdJobLoaded(): "loaded" | "not-loaded" | "unavailable" {
  const domain = launchdDomain();
  if (domain == null) return "unavailable";
  try {
    const { exitCode } = Bun.spawnSync(["launchctl", "print", `${domain}/${LAUNCHD_LABEL}`], { stdout: "ignore", stderr: "ignore", timeout: 10_000 });
    if (exitCode === 0) return "loaded";
    return exitCode === 113 ? "not-loaded" : "unavailable";
  } catch {
    return "unavailable";
  }
}

function systemdTimerActive(): "active" | "not-active" | "unavailable" {
  try {
    const proc = Bun.spawnSync(["systemctl", "--user", "is-active", "tokenmaxxing-check.timer"], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    const state = proc.stdout.toString().trim();
    if (state === "active" || state === "activating" || state === "reloading") return "active";
    if (state === "inactive" || state === "failed" || state === "deactivating" || state === "unknown" || state === "maintenance") return "not-active";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

function uninstallCheckTimer(): boolean {
  if (skipImperativeTimer()) return true;
  if (process.platform === "darwin") {
    const domain = launchdDomain();
    const loaded = launchdJobLoaded();
    const deactivated = loaded === "loaded" && domain != null ? run(["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]) : loaded === "not-loaded";
    rmSync(launchdPlist(), { force: true });
    return deactivated;
  }
  const active = systemdTimerActive();
  const deactivated = active === "active" ? run(["systemctl", "--user", "disable", "--now", "tokenmaxxing-check.timer"]) : active === "not-active";
  rmSync(join(paths.systemdUserDir, "tokenmaxxing-check.timer"), { force: true });
  rmSync(join(paths.systemdUserDir, "tokenmaxxing-check.service"), { force: true });
  run(["systemctl", "--user", "daemon-reload"]);
  return deactivated;
}

export function shellRcPath(): string | null {
  const override = process.env.TOKENMAXXING_SHELL_RC;
  if (override && override.length > 0) return override;
  const shell = basename(process.env.SHELL ?? "");
  if (shell === "zsh") return join(process.env.ZDOTDIR || HOME, ".zshrc");
  if (shell === "bash") return join(HOME, ".bashrc");
  return null;
}

const PATH_LINE_MARK = "# tokenmaxxing PATH";

export function ensurePathInRc(rc: string): "added" | "present" | "skipped" {
  const dir = paths.binDir.startsWith(`${HOME}/`) ? `$HOME${paths.binDir.slice(HOME.length)}` : paths.binDir;
  const target = existsSync(rc) ? realpathSync(rc) : rc;
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  const isCurrentExport = (line: string) => line.includes(`${paths.binDir}:`) || line.includes(`${dir}:`);
  const lines = current === "" ? [] : current.split("\n");
  const kept = lines.filter((line) => isCurrentExport(line) || !line.includes(PATH_LINE_MARK));
  if (kept.length !== lines.length) {
    if (cannotWriteRcTarget(target)) return "skipped";
    const body = kept.join("\n");
    const sep0 = body === "" || body.endsWith("\n") ? "" : "\n";
    const addition = kept.some(isCurrentExport) ? "" : `export PATH="${dir}:$PATH" ${PATH_LINE_MARK}\n`;
    try {
      writeFileAtomic(target, `${body}${sep0}${addition}`, statSync(target).mode & 0o777);
    } catch (e) {
      if (isEacces(e)) return "skipped";
      throw e;
    }
    return "added";
  }
  if (lines.some(isCurrentExport)) return "present";
  if (cannotWriteRcTarget(target)) return "skipped";
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  try {
    appendFileSync(target, `${sep}export PATH="${dir}:$PATH" ${PATH_LINE_MARK}\n`);
  } catch (e) {
    if (isEacces(e)) return "skipped";
    throw e;
  }
  return "added";
}

const ShellShadowerSchema = z.object({
  kind: z.enum(["shadow", "bypass"]),
  name: z.string(),
  line: z.string(),
});
export type ShellShadower = z.infer<typeof ShellShadowerSchema>;

export function findClaudeShadowers(rcText: string): ShellShadower[] {
  const out: ShellShadower[] = [];
  const absClaude = /(?:^|[\s"'=])(\/[^\s"']*\/claude)(?:[\s"']|$)/;
  for (const rawLine of rcText.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#") || line.includes(paths.supervisorLink)) continue;
    const alias = line.match(/^alias\s+([A-Za-z0-9_-]+)=(.*)$/);
    if (alias) {
      if (alias[1] === "claude") {
        out.push(ShellShadowerSchema.parse({ kind: "shadow", name: "claude", line }));
      } else if (absClaude.test(alias[2]!)) {
        out.push(ShellShadowerSchema.parse({ kind: "bypass", name: alias[1]!, line }));
      }
      continue;
    }
    if (/^(?:function\s+)?claude\s*\(\)/.test(line)) {
      out.push(ShellShadowerSchema.parse({ kind: "shadow", name: "claude", line }));
    }
  }
  return out;
}

export function removePathFromRc(rc: string): boolean {
  if (!existsSync(rc)) return false;
  const target = realpathSync(rc);
  const lines = readFileSync(target, "utf8").split("\n");
  const kept = lines.filter((line) => !line.includes(PATH_LINE_MARK));
  if (kept.length === lines.length) return false;
  if (cannotWriteRcTarget(target)) return false;
  try {
    writeFileAtomic(target, kept.join("\n"), statSync(target).mode & 0o777);
  } catch (e) {
    if (isEacces(e)) return false;
    throw e;
  }
  return true;
}

const UninstallOutcomeSchema = z.object({ timerDeactivated: z.boolean(), pathLineRemoved: z.boolean() });
export type UninstallOutcome = z.infer<typeof UninstallOutcomeSchema>;

export function uninstallSupervisor(): UninstallOutcome {
  uninstallSettings();
  const timerDeactivated = uninstallCheckTimer();
  uninstallCodexSupervisor();
  for (const f of [paths.supervisorLink, join(paths.binDir, "xx"), installedBin()]) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
  const rc = shellRcPath();
  const pathLineRemoved = rc != null && removePathFromRc(rc);
  return { timerDeactivated, pathLineRemoved };
}
