#!/usr/bin/env bun

import { basename } from "node:path";
import { runSupervisor } from "./entries/supervisor.ts";
import { runStatusline } from "./entries/statusline.ts";
import { runSubagentStatusline } from "./entries/subagentstatusline.ts";
import { runStopHook } from "./entries/stophook.ts";
import { runStopFailureHook } from "./entries/stopfailurehook.ts";
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
import { cmdCodexRm } from "./cli/codexrm.ts";
import { cmdRename } from "./cli/rename.ts";
import { cmdSwitch } from "./cli/switch.ts";
import { cmdCheck } from "./cli/check.ts";
import { cmdConfig } from "./cli/config.ts";
import { timerDeactivationHint, uninstallSupervisor } from "./lib/install.ts";
import { c, emitError, emitJson } from "./cli/render.ts";

const JSON_FLAG = "--json";
const INTERACTIVE_COMMANDS = new Set(["init", "add", "auth"]);

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
  ${c.cyan("tokenmaxxing status --ping")} [--count N]  ping every account (one tiny haiku request each) so all 5h session timers start now, then sample fresh; ${c.cyan("--count N")} pings N randomly picked accounts instead, to stagger the resets; ${c.cyan("xx --ping")} works too
  ${c.cyan("tokenmaxxing watch")} [seconds]  live status: re-render every N seconds (default 120, never pings)
  ${c.cyan("tokenmaxxing config")} [get|set|unset|tidy]  inspect and edit config.json (bare = effective config with sources)
  ${c.cyan("tokenmaxxing doctor")}     verify the install is intact
  ${c.cyan("tokenmaxxing rename")} [--codex] <sel> <label>
  ${c.cyan("tokenmaxxing rm")} [--codex] <sel>
  ${c.cyan("tokenmaxxing uninstall")}  remove supervisor + settings entries

  ${c.cyan("--json")}                  print one JSON document on stdout instead of text (status, ls, config, doctor, check, switch, rename, rm, uninstall; one per tick for watch); every document carries ${c.bold("ok")}, failures add ${c.bold("error")}

  ${c.dim("(aliased as")} ${c.cyan("xx")}${c.dim(")")} - then just run ${c.bold("claude")} as always; it switches accounts near quota automatically.`);
}

let jsonMode = false;

function statusFlags(rest: string[]): { ping: boolean; pingCount?: number } | { error: string } {
  const ping = rest.includes("--ping");
  const at = rest.indexOf("--count");
  if (at < 0) return { ping };
  const raw = rest[at + 1];
  const pingCount = Number(raw);
  if (!Number.isInteger(pingCount) || pingCount < 1) return { error: `--count needs a positive whole number of accounts, got: ${raw ?? "nothing"}` };
  if (!ping) return { error: "--count only applies together with --ping" };
  return { ping, pingCount };
}

async function main(): Promise<number> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    console.error(`tokenmaxxing supports macOS and Linux only (this is ${process.platform})`);
    return 1;
  }
  const argv = process.argv.slice(2);
  const argv0 = basename(process.argv0 || process.argv[0] || "");

  if (argv0 === "claude" || argv[0] === "__supervise") {
    return runSupervisor(argv[0] === "__supervise" ? argv.slice(1) : argv);
  }
  if (argv0 === "codex" || argv[0] === "__supervise-codex") {
    return runCodexSupervisor({ argv: argv[0] === "__supervise-codex" ? argv.slice(1) : argv });
  }

  jsonMode = argv.includes(JSON_FLAG);
  const json = jsonMode;
  const args = argv.filter((a) => a !== JSON_FLAG);
  const sub = args[0];

  if (json && sub != null && INTERACTIVE_COMMANDS.has(sub)) {
    emitError({ json, message: `${sub} is interactive (it runs a login flow) and has no --json form` });
    return 2;
  }
  if (!(sub != null && sub.startsWith("__")) && !process.env.TOKENMAXXING_PROBE) {
    const nonEmpty = (v: string | undefined) => (v != null && v !== "" ? v : null);
    const ambient = nonEmpty(process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR) ?? nonEmpty(process.env.CLAUDE_CONFIG_DIR);
    if (ambient != null) {
      emitError({
        json,
        message: `CLAUDE_CONFIG_DIR / CLAUDE_SECURESTORAGE_CONFIG_DIR is set (${ambient}): claude uses a namespaced credential store there that tokenmaxxing does not manage - unset it (or run from a clean shell) and retry.`,
      });
      return 1;
    }
  }

  switch (sub) {
    case "__statusline": return runStatusline();
    case "__subagent-statusline": return runSubagentStatusline();
    case "__stop-hook": return runStopHook();
    case "__stop-failure-hook": return runStopFailureHook();
    case "__session-start": return runSessionStart();
    case "__codex-stop-hook": return runCodexStopHook();
    case undefined:
    case "status":
    case "--ping":
    case "--count": {
      const flags = statusFlags(sub === "status" ? args.slice(1) : args);
      if ("error" in flags) {
        emitError({ json, message: flags.error });
        return 2;
      }
      return cmdStatus({ ...flags, json });
    }
    case "switch": {
      const rest = args.slice(1).filter((a) => a !== "--codex");
      return args.includes("--codex") ? cmdCodexSwitch(rest[0], json) : cmdSwitch(rest[0], json);
    }
    case "check": return cmdCheck(args.slice(1), json);
    case "config": return cmdConfig(args.slice(1), json);
    case "init": return args.includes("--codex") ? cmdCodexInit() : cmdInit();
    case "add": return args.includes("--codex") ? cmdCodexAdd() : cmdAdd();
    case "auth": return cmdAuth(args.slice(1));
    case "ls": return cmdLs(json);
    case "watch": return cmdWatch(args[1], json);
    case "doctor": return cmdDoctor(json);
    case "rm": {
      const rest = args.slice(1).filter((a) => a !== "--codex");
      return args.includes("--codex") ? cmdCodexRm(rest[0], json) : cmdRm(rest[0], json);
    }
    case "rename": return cmdRename(args.slice(1), json);
    case "uninstall": {
      const out = uninstallSupervisor();
      const removed = [
        "supervisor wrapper",
        "settings entries",
        ...(out.timerDeactivated ? ["check timer"] : []),
        ...(out.pathLineRemoved ? ["rc PATH line"] : []),
      ];
      if (json) {
        emitJson({ ok: true, removed, timerDeactivated: out.timerDeactivated, pathLineRemoved: out.pathLineRemoved });
        return 0;
      }
      console.log(`removed ${removed.join(", ")}`);
      if (!out.timerDeactivated) console.log(c.yellow(`⚠ the check job may still be loaded - run: ${timerDeactivationHint()}`));
      if (!out.pathLineRemoved) console.log(c.dim("(no tokenmaxxing PATH line found in the shell rc)"));
      console.log(`kept: accounts.json, config.json, and every parked credential (claude - macOS: keychain items, Linux: creds/; codex: codex-creds/) - remove accounts with \`xx rm\` to delete their credentials`);
      return 0;
    }
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return 0;
    default:
      emitError({ json, message: `unknown command: ${sub}` });
      if (!json) printHelp();
      return 2;
  }
}

try {
  process.exit(await main());
} catch (e) {
  emitError({ json: jsonMode, message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
