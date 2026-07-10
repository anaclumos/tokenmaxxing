#!/usr/bin/env bun
// Single multi-call binary. Behaves as the `claude` supervisor when invoked as
// `claude` (or `__supervise`), routes hook/statusLine subcommands, and otherwise
// dispatches the `tokenmaxxing` CLI.

import { basename } from "node:path";
import { runSupervisor } from "./entries/supervisor.ts";
import { runStatusline } from "./entries/statusline.ts";
import { runStopHook } from "./entries/stophook.ts";
import { runSessionStart } from "./entries/sessionstart.ts";
import { cmdInit } from "./cli/init.ts";
import { cmdAdd } from "./cli/add.ts";
import { cmdLs } from "./cli/ls.ts";
import { cmdStatus } from "./cli/status.ts";
import { cmdDoctor } from "./cli/doctor.ts";
import { cmdRm } from "./cli/rm.ts";
import { cmdRename } from "./cli/rename.ts";
import { cmdSwitch } from "./cli/switch.ts";
import { cmdCheck } from "./cli/check.ts";
import { uninstallSupervisor } from "./lib/install.ts";
import { c } from "./cli/render.ts";

function printHelp(): void {
  console.log(`${c.bold("tokenmaxxing")} - automatic Claude Code account switching

  ${c.cyan("tokenmaxxing")}            show the pool with usage bars (alias of ${c.cyan("status")})
  ${c.cyan("tokenmaxxing switch")} [sel]  switch now to the best (or a specific) account
  ${c.cyan("tokenmaxxing check")}      evaluate once, switch if over threshold (run by the periodic timer)
  ${c.cyan("tokenmaxxing init")}       import the current account + install supervisor & hooks
  ${c.cyan("tokenmaxxing add")}        register an additional account (isolated login)
  ${c.cyan("tokenmaxxing ls")}         list pooled accounts
  ${c.cyan("tokenmaxxing status")}     accounts with 5h / weekly / per-model usage bars
  ${c.cyan("tokenmaxxing doctor")}     verify the install is intact
  ${c.cyan("tokenmaxxing rename")} <sel> <label>
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

  switch (sub) {
    case "__statusline": return runStatusline();
    case "__stop-hook": return runStopHook();
    case "__session-start": return runSessionStart();
    case undefined: return cmdStatus(); // bare `tokenmaxxing` / `xx` → status
    case "switch": return cmdSwitch(args[1]);
    case "check": return cmdCheck();
    case "init": return cmdInit();
    case "add": return cmdAdd();
    case "ls": return cmdLs();
    case "status": return cmdStatus();
    case "doctor": return cmdDoctor();
    case "rm": return cmdRm(args[1]);
    case "rename": return cmdRename(args[1], args[2]);
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
