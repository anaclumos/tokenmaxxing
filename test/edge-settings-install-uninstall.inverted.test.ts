import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { freshHome } from "./fixtures.ts";

const home = freshHome();
const settingsPath = join(home, "claude-settings.json");
process.env.TOKENMAXXING_CLAUDE_SETTINGS = settingsPath;

const USER_STOP = { hooks: [{ type: "command", command: "notify-send done" }] };
const USER_PRE_TOOL = { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/guard" }] };
const ALL = (ok: boolean) => ({ statusLineOk: ok, subagentStatusLineOk: ok, stopOk: ok, stopFailureOk: ok, sessionStartOk: ok });

test("inverted: install adds the status lines and hooks once beside the user's own hooks, and uninstall leaves exactly the user's settings", async () => {
  const { checkSettings, installSettings, uninstallSettings } = await import("../src/lib/settings.ts");
  writeFileSync(settingsPath, JSON.stringify({ model: "opus", hooks: { Stop: [USER_STOP], PreToolUse: [USER_PRE_TOOL] } }));
  const read = () => JSON.parse(readFileSync(settingsPath, "utf8"));

  installSettings();
  installSettings();
  const installed = read();
  const afterInstall = { check: checkSettings(), events: Object.keys(installed.hooks).toSorted(), stopGroups: installed.hooks.Stop.length, userStop: installed.hooks.Stop[0], stopFailureMatcher: installed.hooks.StopFailure[0].matcher };
  uninstallSettings();

  expect({ afterInstall, afterUninstall: read(), check: checkSettings() }).toEqual({
    afterInstall: { check: ALL(true), events: ["PreToolUse", "SessionStart", "Stop", "StopFailure"], stopGroups: 2, userStop: USER_STOP, stopFailureMatcher: "rate_limit|oauth_org_not_allowed|billing_error" },
    afterUninstall: { model: "opus", hooks: { Stop: [USER_STOP], PreToolUse: [USER_PRE_TOOL], StopFailure: [], SessionStart: [] } },
    check: ALL(false),
  });
});
