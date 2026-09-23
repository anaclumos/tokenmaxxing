import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { escape } from "es-toolkit";
import { z } from "zod";
import { codexPaths, codexStoreDirFor, HOME, optionalEnv, paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { installedBin, installSettings, isOurHookCommand, uninstallSettings } from "./settings.ts";
import { resolveRealClaude } from "./claudebin.ts";
import { loadConfig, readJsonFile } from "./state.ts";
import { ErrnoSchema } from "./types.ts";

export type InstallOutcome = { claudeWrapper: string; installedBin: string; pathAhead: boolean; timerLoaded: boolean; hubLoaded: boolean; checkIntervalS: number };

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

const envFlag = (name: string): boolean => z.stringbool().optional().parse(optionalEnv(name)) === true;

export function isNixPackaged(): boolean {
  if (envFlag("TOKENMAXXING_NIX")) return true;
  try {
    return realpathSync(Bun.main).startsWith("/nix/store/");
  } catch {
    return false;
  }
}

export function skipImperativeTimer(): boolean {
  return envFlag("TOKENMAXXING_SKIP_TIMER");
}

export function skipImperativeHub(): boolean {
  return envFlag("TOKENMAXXING_SKIP_HUB");
}

function isNixStorePath(path: string): boolean {
  return path === "/nix/store" || path.startsWith("/nix/store/");
}

function cannotWriteRcTarget(target: string): boolean {
  if (envFlag("TOKENMAXXING_SKIP_SHELL_RC")) return true;
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
exec ${JSON.stringify(bun)} --no-env-file run ${JSON.stringify(entry)} "$@"
`;
}

export function installSupervisor(): InstallOutcome {
  mkdirSync(paths.binDir, { recursive: true });
  const target = installedBin();
  const entry = realpathSync(Bun.main);
  if (isNixPackaged()) {
    writeFileAtomic(target, nixSupervisorShim(process.execPath, entry), 0o755);
  } else {
    writeFileAtomic(target, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --no-env-file run ${JSON.stringify(entry)} "$@"\n`, 0o755);
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
    hubLoaded: installHubService(),
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
    ? readJsonFile(codexPaths.hooksJson, CodexHooksFileSchema)
    : CodexHooksFileSchema.parse({});
  const next = {
    ...current,
    hooks: {
      ...current.hooks,
      Stop: [
        ...withoutOurCodexStopHooks(current.hooks.Stop),
        { hooks: [{ type: "command", command: codexStopHookCommand(), timeout: 300, statusMessage: "tokenmaxxing switch check" }] },
      ],
    },
  };
  mkdirSync(codexPaths.home, { recursive: true });
  writeFileAtomic(codexPaths.hooksJson, JSON.stringify(next, null, 2) + "\n");
}

export function uninstallCodexStopHook(): void {
  if (!existsSync(codexPaths.hooksJson)) return;
  const current = readJsonFile(codexPaths.hooksJson, CodexHooksFileSchema);
  const next = {
    ...current,
    hooks: {
      ...current.hooks,
      Stop: withoutOurCodexStopHooks(current.hooks.Stop),
    },
  };
  writeFileAtomic(codexPaths.hooksJson, JSON.stringify(next, null, 2) + "\n");
}

export function codexStopHookGroupIndex(): number | null {
  if (!existsSync(codexPaths.hooksJson)) return null;
  let parsed: z.infer<typeof CodexHooksFileSchema>;
  try {
    parsed = readJsonFile(codexPaths.hooksJson, CodexHooksFileSchema);
  } catch {
    return null;
  }
  const idx = parsed.hooks.Stop.findIndex((group) => group.hooks.some((hook) => isOurHookCommand(hook.command ?? "", CODEX_STOP_HOOK_SUBCOMMAND)));
  return idx >= 0 ? idx : null;
}

const CodexHookStateSchema = z.looseObject({
  hooks: z.looseObject({ state: z.record(z.string(), z.looseObject({ trusted_hash: z.unknown().optional() })).optional() }).optional(),
});

export function codexStoreHookTrust(accountId: string): "trusted" | "untrusted" | "unknown" {
  const group = codexStopHookGroupIndex();
  if (group == null) return "unknown";
  const key = `${join(codexStoreDirFor(accountId), "hooks.json")}:stop:${group}:0`;
  let config: z.infer<typeof CodexHookStateSchema>;
  try {
    config = CodexHookStateSchema.parse(Bun.TOML.parse(readFileSync(join(codexPaths.home, "config.toml"), "utf8")));
  } catch {
    return "unknown";
  }
  return config.hooks?.state?.[key]?.trusted_hash !== undefined ? "trusted" : "untrusted";
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
const LAUNCHD_HUB_LABEL = "com.tokenmaxxing.hub";
const HUB_UNIT = "tokenmaxxing-hub.service";

function launchdPlist(label: string): string {
  return join(paths.launchdAgentsDir, `${label}.plist`);
}

function launchdDomain(): string {
  return `gui/${userInfo().uid}`;
}

function run(cmd: string[]): boolean {
  try {
    return Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore", timeout: 10_000 }).exitCode === 0;
  } catch {
    return false;
  }
}

function systemdEnv(): string {
  return `Environment="TOKENMAXXING_HOME=${paths.home.replaceAll("%", "%%")}"\n`;
}

function launchdEnv(): string {
  return `  <key>EnvironmentVariables</key><dict><key>TOKENMAXXING_HOME</key><string>${escape(paths.home)}</string></dict>\n`;
}

function installCheckTimer(intervalS: number): boolean {
  if (skipImperativeTimer()) return true;

  if (process.platform === "darwin") {
    const plist = launchdPlist(LAUNCHD_LABEL);
    writeFileAtomic(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${escape(installedBin())}</string><string>check</string></array>
  <key>StartInterval</key><integer>${intervalS}</integer>
${launchdEnv()}  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${escape(join(paths.home, "check.stderr.log"))}</string>
</dict>
</plist>
`,
      0o644,
    );
    const domain = launchdDomain();
    run(["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]);
    return run(["launchctl", "bootstrap", domain, plist]) || checkTimerHealthy();
  }

  const exec = `"${installedBin().replaceAll("%", "%%")}" check`;
  writeFileAtomic(
    join(paths.systemdUserDir, "tokenmaxxing-check.service"),
    `[Unit]
Description=tokenmaxxing account-switch check

[Service]
Type=oneshot
ExecStart=${exec}
${systemdEnv()}`,
    0o644,
  );
  writeFileAtomic(
    join(paths.systemdUserDir, "tokenmaxxing-check.timer"),
    `[Unit]
Description=tokenmaxxing periodic account-switch check

[Timer]
OnBootSec=${intervalS}
OnUnitActiveSec=${intervalS}
AccuracySec=${Math.max(1, Math.floor(intervalS / 12))}

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
    return `launchctl bootstrap gui/$(id -u) ${launchdPlist(LAUNCHD_LABEL)}`;
  }
  return "systemctl --user daemon-reload && systemctl --user enable --now tokenmaxxing-check.timer";
}

export function hubActivationHint(): string {
  if (process.platform === "darwin") {
    return `launchctl bootstrap gui/$(id -u) ${launchdPlist(LAUNCHD_HUB_LABEL)}`;
  }
  return `systemctl --user daemon-reload && systemctl --user enable --now ${HUB_UNIT}`;
}

export function checkTimerHealthy(): boolean {
  if (skipImperativeTimer()) return true;
  if (process.platform === "darwin") {
    return existsSync(launchdPlist(LAUNCHD_LABEL)) && run(["launchctl", "print", `${launchdDomain()}/${LAUNCHD_LABEL}`]);
  }
  return (
    existsSync(join(paths.systemdUserDir, "tokenmaxxing-check.timer")) &&
    run(["systemctl", "--user", "is-active", "--quiet", "tokenmaxxing-check.timer"])
  );
}

export function hubServiceHealthy(): boolean {
  if (skipImperativeHub()) return true;
  if (process.platform === "darwin") {
    return existsSync(launchdPlist(LAUNCHD_HUB_LABEL)) && run(["launchctl", "print", `${launchdDomain()}/${LAUNCHD_HUB_LABEL}`]);
  }
  return existsSync(join(paths.systemdUserDir, HUB_UNIT)) && run(["systemctl", "--user", "is-active", "--quiet", HUB_UNIT]);
}

export function timerDeactivationHint(): string {
  if (process.platform === "darwin") {
    return `launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`;
  }
  return "systemctl --user disable --now tokenmaxxing-check.timer";
}

export function hubDeactivationHint(): string {
  if (process.platform === "darwin") {
    return `launchctl bootout gui/$(id -u)/${LAUNCHD_HUB_LABEL}`;
  }
  return `systemctl --user disable --now ${HUB_UNIT}`;
}

function launchdJobLoaded(label: string): "loaded" | "not-loaded" | "unavailable" {
  try {
    const { exitCode } = Bun.spawnSync(["launchctl", "print", `${launchdDomain()}/${label}`], { stdout: "ignore", stderr: "ignore", timeout: 10_000 });
    if (exitCode === 0) return "loaded";
    return exitCode === 113 ? "not-loaded" : "unavailable";
  } catch {
    return "unavailable";
  }
}

function systemdUnitActive(unit: string): "active" | "not-active" | "unavailable" {
  try {
    const proc = Bun.spawnSync(["systemctl", "--user", "is-active", unit], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    const state = proc.stdout.toString().trim();
    if (state === "active" || state === "activating" || state === "reloading") return "active";
    if (state === "inactive" || state === "failed" || state === "deactivating" || state === "unknown" || state === "maintenance") return "not-active";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

function removeTimerUnits(): void {
  if (process.platform === "darwin") {
    rmSync(launchdPlist(LAUNCHD_LABEL), { force: true });
    return;
  }
  rmSync(join(paths.systemdUserDir, "tokenmaxxing-check.timer"), { force: true });
  rmSync(join(paths.systemdUserDir, "tokenmaxxing-check.service"), { force: true });
}

type UnitOutcome = "removed" | "skipped" | "still-loaded";

function uninstallCheckTimer(live: boolean): UnitOutcome {
  if (skipImperativeTimer()) return "skipped";
  if (!live) {
    removeTimerUnits();
    return "removed";
  }
  if (process.platform === "darwin") {
    const loaded = launchdJobLoaded(LAUNCHD_LABEL);
    const deactivated = loaded === "loaded" ? run(["launchctl", "bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`]) : loaded === "not-loaded";
    removeTimerUnits();
    return deactivated ? "removed" : "still-loaded";
  }
  const active = systemdUnitActive("tokenmaxxing-check.timer");
  const deactivated = active !== "unavailable" && (run(["systemctl", "--user", "disable", "--now", "tokenmaxxing-check.timer"]) || active === "not-active");
  removeTimerUnits();
  run(["systemctl", "--user", "daemon-reload"]);
  return deactivated ? "removed" : "still-loaded";
}

function installHubService(): boolean {
  if (skipImperativeHub()) return true;

  if (process.platform === "darwin") {
    const plist = launchdPlist(LAUNCHD_HUB_LABEL);
    writeFileAtomic(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_HUB_LABEL}</string>
  <key>ProgramArguments</key><array><string>${escape(installedBin())}</string><string>serve</string></array>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>RunAtLoad</key><true/>
${launchdEnv()}  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${escape(join(paths.home, "hub.stderr.log"))}</string>
</dict>
</plist>
`,
      0o644,
    );
    const domain = launchdDomain();
    run(["launchctl", "bootout", `${domain}/${LAUNCHD_HUB_LABEL}`]);
    return run(["launchctl", "bootstrap", domain, plist]) || hubServiceHealthy();
  }

  const exec = `"${installedBin().replaceAll("%", "%%")}" serve`;
  writeFileAtomic(
    join(paths.systemdUserDir, HUB_UNIT),
    `[Unit]
Description=tokenmaxxing usage hub
StartLimitIntervalSec=0

[Service]
ExecStart=${exec}
${systemdEnv()}Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
    0o644,
  );
  return run(["systemctl", "--user", "daemon-reload"]) && run(["systemctl", "--user", "enable", "--now", HUB_UNIT]);
}

function removeHubUnits(): void {
  if (process.platform === "darwin") {
    rmSync(launchdPlist(LAUNCHD_HUB_LABEL), { force: true });
    return;
  }
  rmSync(join(paths.systemdUserDir, HUB_UNIT), { force: true });
}

function uninstallHubService(live: boolean): UnitOutcome {
  if (skipImperativeHub()) return "skipped";
  if (!live) {
    removeHubUnits();
    return "removed";
  }
  if (process.platform === "darwin") {
    const loaded = launchdJobLoaded(LAUNCHD_HUB_LABEL);
    const deactivated = loaded === "loaded" ? run(["launchctl", "bootout", `${launchdDomain()}/${LAUNCHD_HUB_LABEL}`]) : loaded === "not-loaded";
    removeHubUnits();
    return deactivated ? "removed" : "still-loaded";
  }
  const active = systemdUnitActive(HUB_UNIT);
  const deactivated = active !== "unavailable" && (run(["systemctl", "--user", "disable", "--now", HUB_UNIT]) || active === "not-active");
  removeHubUnits();
  run(["systemctl", "--user", "daemon-reload"]);
  return deactivated ? "removed" : "still-loaded";
}

export function shellRcPath(): string | null {
  const override = optionalEnv("TOKENMAXXING_SHELL_RC");
  if (override != null) return override;
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
      if (ErrnoSchema.safeParse(e).data?.code === "EACCES") return "skipped";
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
    if (ErrnoSchema.safeParse(e).data?.code === "EACCES") return "skipped";
    throw e;
  }
  return "added";
}

export type ShellShadower = { kind: "shadow" | "bypass"; name: string; line: string };

export function findClaudeShadowers(rcText: string): ShellShadower[] {
  const out: ShellShadower[] = [];
  const absClaude = /(?:^|[\s"'=])(\/[^\s"']*\/claude)(?:[\s"']|$)/;
  for (const rawLine of rcText.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#") || line.includes(paths.supervisorLink)) continue;
    const alias = line.match(/^alias\s+([A-Za-z0-9_-]+)=(.*)$/);
    if (alias) {
      if (alias[1] === "claude") {
        out.push({ kind: "shadow", name: "claude", line });
      } else if (absClaude.test(alias[2]!)) {
        out.push({ kind: "bypass", name: alias[1]!, line });
      }
      continue;
    }
    if (/^(?:function\s+)?claude\s*\(\)/.test(line)) {
      out.push({ kind: "shadow", name: "claude", line });
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
    if (ErrnoSchema.safeParse(e).data?.code === "EACCES") return false;
    throw e;
  }
  return true;
}

export type UninstallOutcome = { timer: UnitOutcome; hub: UnitOutcome; pathLineRemoved: boolean };

export function loginHome(): string {
  const cmd = process.platform === "darwin" ? ["id", "-P"] : ["getent", "passwd", String(userInfo().uid)];
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
  const home = proc.stdout.toString().trim().split(":").at(-2);
  if (proc.exitCode !== 0 || home == null || home === "") throw new Error(`cannot read the login home: ${cmd.join(" ")} failed`);
  return home;
}

export function onLoginHome(): boolean {
  return resolve(HOME) === resolve(loginHome());
}

export function uninstallTargets(live: boolean): string[] {
  const timer =
    process.platform === "darwin"
      ? `${launchdPlist(LAUNCHD_LABEL)}${live ? ` (and launchctl bootout ${launchdDomain()}/${LAUNCHD_LABEL})` : ""}`
      : `${join(paths.systemdUserDir, "tokenmaxxing-check.timer")} and .service${live ? " (and systemctl --user disable --now tokenmaxxing-check.timer)" : ""}`;
  const hub =
    process.platform === "darwin"
      ? `${launchdPlist(LAUNCHD_HUB_LABEL)}${live ? ` (and launchctl bootout ${launchdDomain()}/${LAUNCHD_HUB_LABEL})` : ""}`
      : `${join(paths.systemdUserDir, HUB_UNIT)}${live ? ` (and systemctl --user disable --now ${HUB_UNIT})` : ""}`;
  const rc = shellRcPath();
  return [
    `${paths.claudeSettings}: the hook and statusline entries`,
    `${codexPaths.hooksJson}: the codex Stop hook entry`,
    ...(skipImperativeTimer() ? [] : [timer]),
    ...(skipImperativeHub() ? [] : [hub]),
    paths.supervisorLink,
    codexSupervisorLink(),
    join(paths.binDir, "xx"),
    installedBin(),
    ...(rc == null ? [] : [`${rc}: the ${PATH_LINE_MARK} line`]),
  ];
}

export function uninstallSupervisor(input: { live: boolean }): UninstallOutcome {
  uninstallSettings();
  const timer = uninstallCheckTimer(input.live);
  const hub = uninstallHubService(input.live);
  uninstallCodexSupervisor();
  for (const f of [paths.supervisorLink, join(paths.binDir, "xx"), installedBin()]) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
  const rc = shellRcPath();
  const pathLineRemoved = rc != null && removePathFromRc(rc);
  return { timer, hub, pathLineRemoved };
}
