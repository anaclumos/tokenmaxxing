#!/usr/bin/env bun
// Single multi-call binary. Behaves as the `claude` supervisor when invoked as
// `claude` (or `__supervise`), routes hook/statusLine subcommands, and otherwise
// dispatches the `tokenmaxxing` CLI.

import { basename } from "node:path";
import { runSupervisor } from "./entries/supervisor.ts";
import { runStatusline } from "./entries/statusline.ts";
import { runSubagentStatusline } from "./entries/subagentstatusline.ts";
import { runStopHook } from "./entries/stophook.ts";
import { runSessionStart } from "./entries/sessionstart.ts";
import { cmdInit } from "./cli/init.ts";
import { cmdAdd } from "./cli/add.ts";
import { cmdAuth } from "./cli/auth.ts";
import { cmdCodexAdd } from "./cli/codexadd.ts";
import { cmdCodexInit } from "./cli/codexinit.ts";
import { cmdCodexSwitch } from "./cli/codexswitch.ts";
import { runCodexSupervisor } from "./entries/codexsupervisor.ts";
import { runCodexStopHook } from "./entries/codexstophook.ts";
import { cmdLs } from "./cli/ls.ts";
import { cmdStatus } from "./cli/status.ts";
import { cmdWatch } from "./cli/watch.ts";
import { cmdDoctor } from "./cli/doctor.ts";
import { cmdRm } from "./cli/rm.ts";
import { cmdRename } from "./cli/rename.ts";
import { cmdSwitch } from "./cli/switch.ts";
import { cmdCheck } from "./cli/check.ts";
import { cmdConfig } from "./cli/config.ts";
import { cmdServe } from "./cli/serve.ts";
import { uninstallSupervisor } from "./lib/install.ts";
import { c } from "./cli/render.ts";

function printHelp(): void {
  console.log(`${c.bold("tokenmaxxing")} - automatic Claude Code account switching

  ${c.cyan("tokenmaxxing")}            show the pool with usage bars (alias of ${c.cyan("status")})
  ${c.cyan("tokenmaxxing switch")} [sel]  switch to the best (or a specific) account; no-op when already on it
  ${c.cyan("tokenmaxxing check")}      evaluate once, switch if over threshold (run by the periodic timer)
  ${c.cyan("tokenmaxxing init")}       import the current account + install supervisor & hooks
  ${c.cyan("tokenmaxxing init --codex")}  same for codex: import login, install codex supervisor + Stop hook (trust it via /hooks)
  ${c.cyan("tokenmaxxing add")}        register an additional account (isolated login)
  ${c.cyan("tokenmaxxing add --codex")}   register an additional codex account (isolated login)
  ${c.cyan("tokenmaxxing auth")} [sel | --all]  reauthenticate a pooled account in place (bare = pick from a list; --all = every needs-reauth account, one by one)
  ${c.cyan("tokenmaxxing switch --codex")} [sel]  switch the codex pool (takes effect on next codex start)
  ${c.cyan("tokenmaxxing ls")}         list pooled accounts
  ${c.cyan("tokenmaxxing status")}     accounts with 5h / weekly / per-model usage bars
  ${c.cyan("tokenmaxxing status --force")}  ping every account (one tiny haiku request each) so all 5h session timers start now, then sample fresh; ${c.cyan("xx --force")} works too
  ${c.cyan("tokenmaxxing watch")} [seconds]  live status: re-render every N seconds (default 120, never pings)
  ${c.cyan("tokenmaxxing config")} [get|set|unset|tidy]  inspect and edit config.json (bare = effective config with sources)
  ${c.cyan("tokenmaxxing serve")} [setup|link|unlink|links]  Slack bridge daemon: mention the bot in a linked channel to open a claude session per thread (worktree by default)
  ${c.cyan("tokenmaxxing doctor")}     verify the install is intact
  ${c.cyan("tokenmaxxing rename")} [--codex] <sel> <label>
  ${c.cyan("tokenmaxxing rm")} <sel>
  ${c.cyan("tokenmaxxing uninstall")}  remove supervisor + settings entries

  ${c.dim("(aliased as")} ${c.cyan("xx")}${c.dim(")")} - then just run ${c.bold("claude")} as always; it switches accounts near quota automatically.`);
}

async function main(): Promise<number> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    console.error(`tokenmaxxing supports macOS and Linux only (this is ${process.platform})`);
    return 1;
  }
  const args = process.argv.slice(2);
  const argv0 = basename(process.argv0 || process.argv[0] || "");
  const sub = args[0];

  // supervisor mode: invoked as `claude`, or explicit `__supervise`
  if (argv0 === "claude" || sub === "__supervise") {
    return runSupervisor(sub === "__supervise" ? args.slice(1) : args);
  }
  if (argv0 === "codex" || sub === "__supervise-codex") {
    return runCodexSupervisor({ argv: sub === "__supervise-codex" ? args.slice(1) : args });
  }

  switch (sub) {
    case "__statusline": return runStatusline();
    case "__subagent-statusline": return runSubagentStatusline();
    case "__stop-hook": return runStopHook();
    case "__session-start": return runSessionStart();
    case "__codex-stop-hook": return runCodexStopHook();
    case undefined: return cmdStatus(); // bare `tokenmaxxing` / `xx` → status
    case "--force": return cmdStatus(true); // bare `xx --force` → status --force
    case "switch": return args[1] === "--codex" ? cmdCodexSwitch(args[2]) : cmdSwitch(args[1]);
    case "check": return cmdCheck();
    case "config": return cmdConfig(args.slice(1));
    case "serve": return cmdServe(args.slice(1));
    case "init": return args.includes("--codex") ? cmdCodexInit() : cmdInit();
    case "add": return args.includes("--codex") ? cmdCodexAdd() : cmdAdd();
    case "auth": return cmdAuth(args.slice(1));
    case "ls": return cmdLs();
    case "status": return cmdStatus(args.includes("--force"));
    case "watch": return cmdWatch(args[1]);
    case "doctor": return cmdDoctor();
    case "rm": return cmdRm(args[1]);
    case "rename": return cmdRename(args.slice(1));
    case "uninstall":
      uninstallSupervisor();
      console.log("removed supervisor wrapper + settings entries (accounts/credentials kept)");
      return 0;
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return 0;
    default:
      console.error(c.red(`unknown command: ${sub}`));
      printHelp();
      return 2;
  }
}

process.exit(await main());
