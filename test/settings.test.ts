import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { installSettings, uninstallSettings, checkSettings, readPriorStatusLine } from "../src/lib/settings.ts";

const settingsPath = process.env.TOKENMAXXING_CLAUDE_SETTINGS!;
const priorFile = process.env.TOKENMAXXING_HOME! + "/prior-statusline.json";

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
  if (existsSync(priorFile)) rmSync(priorFile);
});

function read() {
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}

describe("settings merge", () => {
  test("wraps prior statusLine and preserves it", () => {
    const r = installSettings();
    expect(r.priorStatusLine).toBe("my-existing-statusline --fancy");
    expect(readPriorStatusLine()).toBe("my-existing-statusline --fancy");
    expect(read().statusLine.command).toContain("__statusline");
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
    expect(c.stopOk).toBe(true);
    expect(c.sessionStartOk).toBe(true);
  });

  test("uninstall restores prior statusLine and removes our hooks", () => {
    installSettings();
    uninstallSettings();
    const s = read();
    expect(s.statusLine.command).toBe("my-existing-statusline --fancy");
    const stopCmds = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCmds).toContain("/orca/hook.sh");
    expect(stopCmds.some((c: string) => c.includes("__stop-hook"))).toBe(false);
    expect(checkSettings().stopOk).toBe(false);
  });
});
