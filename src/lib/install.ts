// Install/uninstall the on-PATH `claude` supervisor wrapper + settings entries.
// The wrapper is a 2-line `exec ... __supervise "$@"` shim so dispatch never
// depends on argv0 semantics.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { escape } from "es-toolkit";
import { z } from "zod";
import { codexPaths, HOME, paths } from "./paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { installedBin, installSettings, isOurHookCommand, uninstallSettings } from "./settings.ts";
import { resolveRealClaude } from "./claudebin.ts";

const InstallOutcomeSchema = z.object({
  claudeWrapper: z.string(),
  installedBin: z.string(),
  pathAhead: z.boolean(),
  timerLoaded: z.boolean(),
});
export type InstallOutcome = z.infer<typeof InstallOutcomeSchema>;

/** True if our binDir comes before the real claude's dir on PATH. */
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

export function installSupervisor(): InstallOutcome {
  mkdirSync(paths.binDir, { recursive: true });
  const target = installedBin(); // binDir/tokenmaxxing
  // Resolve the entry through the global-bin symlink (bun add -g links
  // ~/.bun/bin/tokenmaxxing → the package's src/main.ts) so the shim points
  // into the installed package tree, where its imports resolve.
  const entry = realpathSync(Bun.main);
  writeFileAtomic(target, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(entry)} "$@"\n`, 0o755);

  // the on-PATH `claude` wrapper
  writeFileAtomic(paths.supervisorLink, `#!/bin/sh\nexec ${JSON.stringify(target)} __supervise "$@"\n`, 0o755);
  // the `xx` short alias → tokenmaxxing
  writeFileAtomic(join(paths.binDir, "xx"), `#!/bin/sh\nexec ${JSON.stringify(target)} "$@"\n`, 0o755);

  installSettings();
  return {
    claudeWrapper: paths.supervisorLink,
    installedBin: target,
    pathAhead: isBinDirAhead(),
    timerLoaded: installCheckTimer(),
  };
}

// ---- codex supervisor + Stop hook -------------------------------------------

/** Codex hook declarations we merge into. The FILE nests the event map under a
 *  `hooks` field (`struct HooksFile { description?, hooks }`, binary-verified
 *  0.144.4 after a live parse failure proved the docs' claude-style top-level
 *  event map wrong: "unknown field Stop, expected description or hooks").
 *  Loose everywhere: every other event and every foreign Stop entry rides
 *  along verbatim. */
const CodexHookEventsSchema = z.looseObject({
  Stop: z.array(z.looseObject({ hooks: z.array(z.looseObject({ command: z.string().optional() })).default([]) })).default([]),
});
const CodexHooksFileSchema = z.looseObject({
  description: z.string().optional(),
  hooks: CodexHookEventsSchema.default({ Stop: [] }),
});

const CODEX_STOP_HOOK_SUBCOMMAND = "__codex-stop-hook";

function codexStopHookCommand(): string {
  // Quoted like the claude shim commands: an install path with a space would
  // otherwise mis-split and the hook would silently never run.
  return `${JSON.stringify(installedBin())} ${CODEX_STOP_HOOK_SUBCOMMAND}`;
}

/** Idempotently install the tokenmaxxing Stop entry in ~/.codex/hooks.json,
 *  preserving every other declaration. Codex skips new hooks until the user
 *  trusts them via /hooks (trust is recorded against the hook's hash), so the
 *  caller must surface that step. */
/** Surgical WITHIN groups, ownership verified structurally (closing-review
 *  catch, mirroring settings.ts's removeHook fix): the old whole-group filter
 *  deleted a foreign hook the user had appended into our group - the natural
 *  edit, since install writes exactly one group - and its includes() match
 *  claimed any command merely mentioning the subcommand. */
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

/** The on-PATH `codex` wrapper + the Stop hook declaration. */
export function installCodexSupervisor(): void {
  mkdirSync(paths.binDir, { recursive: true });
  writeFileAtomic(codexSupervisorLink(), `#!/bin/sh\nexec ${JSON.stringify(installedBin())} __supervise-codex "$@"\n`, 0o755);
  installCodexStopHook();
}

export function uninstallCodexSupervisor(): void {
  uninstallCodexStopHook();
  if (existsSync(codexSupervisorLink())) rmSync(codexSupervisorLink(), { force: true });
}

// ---- periodic `check` timer ------------------------------------------------
// The hooks evaluate only at turn boundaries; one long agentic turn can burn a
// window from healthy to depleted with zero boundaries (2026-07-10 incident).
// A timer closes that gap: launchd on macOS, a systemd user timer on Linux.

const CHECK_INTERVAL_S = 180;
const LAUNCHD_LABEL = "com.tokenmaxxing.check";

function launchdPlist(): string {
  return join(paths.launchdAgentsDir, `${LAUNCHD_LABEL}.plist`);
}

/** `gui/<uid>` launchd domain, or null when the platform has no getuid. */
function launchdDomain(): string | null {
  const uid = process.getuid?.();
  return uid == null ? null : `gui/${uid}`;
}

/** launchctl/systemctl may be absent (spawnSync throws ENOENT) or hang on a
 *  dead session bus (ssh without lingering) - degrade, never crash or block. */
function run(cmd: string[]): boolean {
  try {
    return Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore", timeout: 10_000 }).exitCode === 0;
  } catch {
    return false;
  }
}

/** Install + activate the periodic check job. False means the unit files are in
 *  place but activation failed (e.g. systemd user session absent over ssh) -
 *  the caller prints the manual activation step. */
function installCheckTimer(): boolean {
  if (process.platform === "darwin") {
    const plist = launchdPlist();
    writeFileAtomic(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${escape(installedBin())}</string><string>check</string></array>
  <key>StartInterval</key><integer>${CHECK_INTERVAL_S}</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${escape(join(paths.home, "check.stderr.log"))}</string>
</dict>
</plist>
`,
      0o644,
    );
    const domain = launchdDomain();
    if (domain == null) return false;
    run(["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]); // reload a changed plist
    // bootstrap can lose a benign race with an in-flight bootout; loaded is loaded.
    return run(["launchctl", "bootstrap", domain, plist]) || checkTimerHealthy();
  }

  // systemd: quote the path and escape `%` (unit-file specifier character).
  const exec = `"${installedBin().replaceAll("%", "%%")}" check`;
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
OnUnitActiveSec=${CHECK_INTERVAL_S}
AccuracySec=30

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

/** The manual activation command for an unloaded timer, per platform. */
export function timerActivationHint(): string {
  if (process.platform === "darwin") {
    return `launchctl bootstrap gui/$(id -u) ${launchdPlist()}`;
  }
  return "systemctl --user daemon-reload && systemctl --user enable --now tokenmaxxing-check.timer";
}

/** True when the timer unit exists AND the service manager reports it loaded. */
export function checkTimerHealthy(): boolean {
  if (process.platform === "darwin") {
    const domain = launchdDomain();
    return existsSync(launchdPlist()) && domain != null && run(["launchctl", "print", `${domain}/${LAUNCHD_LABEL}`]);
  }
  return (
    existsSync(join(paths.systemdUserDir, "tokenmaxxing-check.timer")) &&
    run(["systemctl", "--user", "is-active", "--quiet", "tokenmaxxing-check.timer"])
  );
}

/** The manual deactivation command for a still-loaded timer, per platform. */
export function timerDeactivationHint(): string {
  if (process.platform === "darwin") {
    return `launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`;
  }
  return "systemctl --user disable --now tokenmaxxing-check.timer";
}

/** Is the launchd check job loaded? Exit contract verified on this machine
 *  (macOS 26, 2026-07-20): `launchctl print` exits 0 for a loaded job and 113
 *  for a missing one. Anything else - including a spawn failure or timeout -
 *  is "unavailable": an unanswerable probe must never read as "not loaded". */
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

/** Is the systemd check timer active? Classification goes by the state
 *  string, never the exit code: systemctl(1) documents only "0 if at least
 *  one is active, non-zero otherwise" for is-active, but guarantees "unless
 *  --quiet is specified, this will also print the current unit state to
 *  standard output" (verified against the systemd manpage 2026-07-20). The
 *  failure mode is container-verified (ubuntu:24.04 systemd, no user bus,
 *  2026-07-20): a dead session bus prints NOTHING to stdout ("Failed to
 *  connect to bus" goes to stderr, exit 1), so an empty or unrecognized
 *  stdout is "unavailable" - "cannot ask" never reads as "inactive". */
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

/** True when the job is verifiably no longer loaded. A swallowed bootout
 *  failure once meant a half-uninstalled state kept firing `tokenmaxxing
 *  check` every 180s against a package that may be gone, silently
 *  (closing-review catch): deactivation is checked, not assumed - a job seen
 *  loaded must deactivate successfully, and an unanswerable probe (service
 *  manager unusable) reports false rather than pretending it is gone. */
function uninstallCheckTimer(): boolean {
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

/** The rc file of the user's login shell, or null when the shell is unknown.
 *  Overridable for hermetic tests. */
export function shellRcPath(): string | null {
  const override = process.env.TOKENMAXXING_SHELL_RC;
  if (override && override.length > 0) return override;
  const shell = basename(process.env.SHELL ?? "");
  if (shell === "zsh") return join(process.env.ZDOTDIR || HOME, ".zshrc");
  if (shell === "bash") return join(HOME, ".bashrc");
  return null;
}

const PATH_LINE_MARK = "# tokenmaxxing PATH";

/** Idempotently append the supervisor-bin PATH line to `rc` (created if absent).
 *  A pre-existing hand-added line for the bin dir also counts as present. */
export function ensurePathInRc(rc: string): "added" | "present" {
  const dir = paths.binDir.startsWith(`${HOME}/`) ? `$HOME${paths.binDir.slice(HOME.length)}` : paths.binDir;
  // Write through a dotfile-managed symlink, never over it: writeFileAtomic
  // renames a sibling temp over its target, which would replace the link with
  // a plain file while the dotfiles target keeps the stale line (PR #36
  // second-round catch).
  const target = existsSync(rc) ? realpathSync(rc) : rc;
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  const isCurrentExport = (line: string) => line.includes(`${paths.binDir}:`) || line.includes(`${dir}:`);
  const lines = current === "" ? [] : current.split("\n");
  // A marked line for a DIFFERENT dir is removed even when the current dir is
  // also exported: PATH prepends stack, so a stale marked line BELOW the
  // current one would still win resolution - the recursion incident's exact
  // vector (closing-review catch + PR #36 second-round catch). A bare marker
  // check alone once kept such a line alive after a TOKENMAXXING_HOME
  // relocation.
  const kept = lines.filter((line) => isCurrentExport(line) || !line.includes(PATH_LINE_MARK));
  if (kept.length !== lines.length) {
    const body = kept.join("\n");
    const sep0 = body === "" || body.endsWith("\n") ? "" : "\n";
    const addition = kept.some(isCurrentExport) ? "" : `export PATH="${dir}:$PATH" ${PATH_LINE_MARK}\n`;
    // preserve the rc's own mode: writeFileAtomic defaults to 0600, which
    // would silently tighten a normally 0644 shell rc (PR #36 review catch)
    writeFileAtomic(target, `${body}${sep0}${addition}`, statSync(target).mode & 0o777);
    return "added";
  }
  if (lines.some(isCurrentExport)) return "present";
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(target, `${sep}export PATH="${dir}:$PATH" ${PATH_LINE_MARK}\n`);
  return "added";
}

const ShellShadowerSchema = z.object({
  /** shadow: a `claude` alias/function hides the wrapper entirely.
   *  bypass: another alias (e.g. `cc`, `cco`) hardcodes an absolute path to a
   *  claude binary, so launches through it skip supervision. */
  kind: z.enum(["shadow", "bypass"]),
  name: z.string(),
  line: z.string(),
});
export type ShellShadower = z.infer<typeof ShellShadowerSchema>;

/** Scan shell-rc text for aliases/functions that shadow `claude` or hardcode a
 *  path to a claude binary. Aliases whose body starts with plain `claude` are
 *  fine (they expand through PATH into the wrapper); an absolute path is not.
 *  Lines referencing the wrapper itself are deliberate and skipped. */
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

/** Remove ONLY the marker-tagged PATH line this tool added; a hand-added
 *  PATH entry without the marker is the user's own. A stale `# tokenmaxxing
 *  PATH` line pointing at an emptied binDir is exactly how the supervisor
 *  recursion incident started (see AGENTS.md), so uninstall must not leave
 *  one behind (closing-review catch). Returns true when a line was removed. */
export function removePathFromRc(rc: string): boolean {
  if (!existsSync(rc)) return false;
  // same symlink + mode treatment as ensurePathInRc: write through a
  // dotfile-managed link, keep the rc's own permissions (PR #36 catches)
  const target = realpathSync(rc);
  const lines = readFileSync(target, "utf8").split("\n");
  const kept = lines.filter((line) => !line.includes(PATH_LINE_MARK));
  if (kept.length === lines.length) return false;
  writeFileAtomic(target, kept.join("\n"), statSync(target).mode & 0o777);
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
