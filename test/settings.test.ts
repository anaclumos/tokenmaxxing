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
    expect(stopCmds).toContain("/orca/hook.sh"); // existing preserved
    expect(stopCmds.some((c: string) => c.includes("__stop-hook"))).toBe(true); // ours added
    expect(s.hooks.PostToolUse).toBeTruthy(); // untouched
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
    expect(c.sessionStartOk).toBe(true);
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
    uninstallSettings(); // never installed: seed statusLine is not ours
    expect(read().statusLine.command).toBe("my-existing-statusline --fancy");
  });

  test("install preserves the file's mode; a new file starts 0600", () => {
    chmodSync(settingsPath, 0o600);
    installSettings();
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600); // never widened
    rmSync(settingsPath, { force: true });
    installSettings();
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600); // safe default
  });

  test("a stale-path hook is rewritten to the current install and reads unhealthy until then", () => {
    const stale = { ...seed(), hooks: { Stop: [{ hooks: [{ type: "command", command: '"/old/home/bin/tokenmaxxing" __stop-hook' }] }] } };
    writeFileSync(settingsPath, JSON.stringify(stale, null, 2));
    expect(checkSettings().stopOk).toBe(false); // old path = broken, not installed
    installSettings();
    const cmds: string[] = read().hooks.Stop.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
    const ours = cmds.filter((cmd) => cmd.includes("__stop-hook"));
    expect(ours.length).toBe(1); // stale entry replaced, not accumulated
    expect(ours[0]).not.toContain("/old/home");
    expect(checkSettings().stopOk).toBe(true);
  });
});
