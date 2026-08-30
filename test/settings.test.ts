import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { installSettings, uninstallSettings, checkSettings } from "../src/lib/settings.ts";

const settingsPath = process.env.TOKENMAXXING_CLAUDE_SETTINGS!;

const seed = () => ({
  model: "claude-fable-5",
  statusLine: { type: "command", command: "my-existing-statusline --fancy" },
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "/orca/hook.sh" }] }],
    PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "git-ai checkpoint" }] }],
  },
});

beforeEach(() => {
  writeFileSync(settingsPath, JSON.stringify(seed(), null, 2));
});

function read() {
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}

describe("settings merge", () => {
  test("takes the statusLine slots, replacing any other command", () => {
    installSettings();
    expect(read().statusLine.command).toContain("__statusline");
    expect(read().subagentStatusLine.command).toContain("__subagent-statusline");
  });

  test("appends our Stop hook without dropping the existing one; adds SessionStart", () => {
    installSettings();
    const s = read();
    const stopCmds = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCmds).toContain("/orca/hook.sh");
    expect(stopCmds.some((c: string) => c.includes("__stop-hook"))).toBe(true);
    expect(s.hooks.PostToolUse).toBeTruthy();
    const ssCmds = s.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(ssCmds.some((c: string) => c.includes("__session-start"))).toBe(true);
  });

  test("idempotent: installing twice does not duplicate", () => {
    installSettings();
    installSettings();
    const s = read();
    const stopOurs = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command)).filter((c: string) => c.includes("__stop-hook"));
    expect(stopOurs.length).toBe(1);
  });

  test("checkSettings reports installed", () => {
    installSettings();
    const c = checkSettings();
    expect(c.statusLineOk).toBe(true);
    expect(c.subagentStatusLineOk).toBe(true);
    expect(c.stopOk).toBe(true);
    expect(c.stopFailureOk).toBe(true);
    expect(c.sessionStartOk).toBe(true);
  });

  test("the StopFailure hook is installed under a rate_limit matcher and removed on uninstall", () => {
    installSettings();
    const groups = read().hooks.StopFailure;
    expect(groups).toHaveLength(1);
    expect(groups[0].matcher).toBe("rate_limit");
    expect(groups[0].hooks[0].command).toContain("__stop-failure-hook");
    installSettings();
    expect(read().hooks.StopFailure).toHaveLength(1);
    uninstallSettings();
    expect(read().hooks.StopFailure).toBeUndefined();
    expect(checkSettings().stopFailureOk).toBe(false);
  });

  test("a StopFailure entry without the matcher does not count as installed", () => {
    installSettings();
    const s = read();
    delete s.hooks.StopFailure[0].matcher;
    writeFileSync(settingsPath, JSON.stringify(s, null, 2));
    expect(checkSettings().stopFailureOk).toBe(false);
  });

  test("uninstall removes our statusLine and hooks, keeps foreign entries", () => {
    installSettings();
    uninstallSettings();
    const s = read();
    expect(s.statusLine).toBeUndefined();
    expect(s.subagentStatusLine).toBeUndefined();
    const stopCmds = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCmds).toContain("/orca/hook.sh");
    expect(stopCmds.some((c: string) => c.includes("__stop-hook"))).toBe(false);
    expect(checkSettings().stopOk).toBe(false);
  });

  test("uninstall leaves a foreign statusLine alone", () => {
    uninstallSettings();
    expect(read().statusLine.command).toBe("my-existing-statusline --fancy");
  });

  test("install preserves the file's mode; a new file starts 0600", () => {
    chmodSync(settingsPath, 0o600);
    installSettings();
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    rmSync(settingsPath, { force: true });
    installSettings();
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  test("a stale-path hook is rewritten to the current install and reads unhealthy until then", () => {
    const stale = { ...seed(), hooks: { Stop: [{ hooks: [{ type: "command", command: '"/old/home/bin/tokenmaxxing" __stop-hook' }] }] } };
    writeFileSync(settingsPath, JSON.stringify(stale, null, 2));
    expect(checkSettings().stopOk).toBe(false);
    installSettings();
    const cmds: string[] = read().hooks.Stop.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    const ours = cmds.filter((cmd) => cmd.includes("__stop-hook"));
    expect(ours.length).toBe(1);
    expect(ours[0]).not.toContain("/old/home");
    expect(checkSettings().stopOk).toBe(true);
  });

  test("a foreign hook sharing our group, or merely mentioning our strings, survives reinstall", () => {
    const shared = {
      ...seed(),
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: '"/old/home/bin/tokenmaxxing" __stop-hook' }, { type: "command", command: "/orca/other.sh" }] },
          { hooks: [{ type: "command", command: "sh -c 'log __stop-hook ran'" }] },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(shared, null, 2));
    installSettings();
    const cmds: string[] = read().hooks.Stop.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    expect(cmds).toContain("/orca/other.sh");
    expect(cmds).toContain("sh -c 'log __stop-hook ran'");
    expect(cmds.filter((cmd) => cmd.startsWith('"'))).toHaveLength(1);
    expect(cmds).not.toContain('"/old/home/bin/tokenmaxxing" __stop-hook');
  });

  test("a foreign command mentioning the path and subcommand as text never green-lights doctor", () => {
    const decoyCmd = "echo tokenmaxxing __stop-hook seen";
    const decoy = { ...seed(), hooks: { Stop: [{ hooks: [{ type: "command", command: decoyCmd }] }] } };
    writeFileSync(settingsPath, JSON.stringify(decoy, null, 2));
    expect(checkSettings().stopOk).toBe(false);
  });
});
