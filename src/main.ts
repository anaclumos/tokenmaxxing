#!/usr/bin/env bun

import { basename } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { runSupervisor } from "./entries/supervisor.ts";
import { runStatusline } from "./entries/statusline.ts";
import { runSubagentStatusline } from "./entries/subagentstatusline.ts";
import { runBoundaryHook } from "./entries/stophook.ts";
import { runStopFailureHook } from "./entries/stopfailurehook.ts";
import { runCodexSupervisor } from "./entries/codexsupervisor.ts";
import { runCodexStopHook } from "./entries/codexstophook.ts";
import { runPiSupervisor } from "./entries/pisupervisor.ts";
import { claude } from "./lib/claude.ts";
import { codex } from "./lib/codex.ts";
import { grok } from "./lib/grok.ts";
import { cmdInit, cmdInitPi } from "./cli/init.ts";
import { cmdAdd } from "./cli/add.ts";
import { cmdAuth } from "./cli/auth.ts";
import { cmdStatus } from "./cli/status.ts";
import { cmdDoctor } from "./cli/doctor.ts";
import { cmdRm } from "./cli/rm.ts";
import { cmdRename } from "./cli/rename.ts";
import { cmdKey } from "./cli/key.ts";
import { cmdCheck } from "./cli/check.ts";
import { cmdConfig } from "./cli/config.ts";
import { cmdSeat } from "./cli/seat.ts";
import { cmdServe } from "./cli/serve.ts";
import { CHECK_JOB, deactivationHint, HUB_JOB, onLoginHome, uninstallSupervisor, uninstallTargets } from "./lib/install.ts";
import { errorMessage } from "./lib/log.ts";
import { HOME } from "./lib/paths.ts";
import { c, count, emitError } from "./cli/render.ts";

const JSON_FLAG = "--json";
const CACHED_FLAG = "--cached";
const YES_FLAG = "--yes";
const CODEX_FLAG = "--codex";
const GROK_FLAG = "--grok";
const PI_FLAG = "--pi";
const JSON_COMMANDS = new Set(["status", "config", "check"]);
const CODEX_COMMANDS = new Set(["init", "add", "auth", "rm", "rename", "seat"]);
const STATUS_ONLY_COMMANDS = new Set(["init", "add", "auth", "rm", "rename"]);
const MAX_OPERANDS = new Map([["init", 0], ["add", 0], ["rm", 1], ["rename", 2], ["key", 4]]);

function printHelp(): void {
  console.log(`${c.bold("tokenmaxxing")} - automatic Claude Code account switching

  ${c.cyan("tokenmaxxing")}            show the pool with usage bars (alias of ${c.cyan("status")})
  ${c.cyan("tokenmaxxing check")}      sample up to three accounts whose last usage attempts are oldest (run by the periodic timer)
  ${c.cyan("tokenmaxxing init")}       log in the first account (isolated) + install supervisor & hooks
  ${c.cyan("tokenmaxxing init --codex")}  same for codex: log in the first account, isolated, install codex supervisor + Stop hook
  ${c.cyan("tokenmaxxing init --pi")}     install the pi supervisor: pi sessions run on pooled Claude or ChatGPT accounts that are logged into pi
  ${c.cyan("tokenmaxxing init --grok")}   pool grok Build logins (status-only: no supervisor yet)
  ${c.cyan("tokenmaxxing add")}        register an additional account (isolated login)
  ${c.cyan("tokenmaxxing add")} --codex | --grok   same for the codex or grok pool
  ${c.cyan("tokenmaxxing auth")} [--codex | --grok] [sel | --all]  reauthenticate a pooled account in place (bare = pick from a list; --all = every account that is flagged or has no usable credential in its store, one by one)
  ${c.cyan("tokenmaxxing auth --pi")} [--codex] [sel | --all]  log a pooled Claude account (or a codex account with --codex) into pi, isolated (bare = pick from a list; --all = every account without a pi login)
  ${c.cyan("tokenmaxxing status")} [--cached]  accounts with 5h / weekly / per-model usage bars (--cached: the stored figures, no sampling)
  ${c.cyan("tokenmaxxing config")}     print the config path and the effective values (edit the file in an editor)
  ${c.cyan("tokenmaxxing doctor")}     verify the install is intact
  ${c.cyan("tokenmaxxing rename")} [--codex | --grok] <sel> <label>
  ${c.cyan("tokenmaxxing rm")} [--codex | --grok] <sel>
  ${c.cyan("tokenmaxxing key add")} <label> [credit-usd] [workspace-id]  store an Anthropic API key read from stdin; Claude sessions run on it only while every pooled Claude account is at its limit (workspace-id: for a key that spans several workspaces)
  ${c.cyan("tokenmaxxing key credit")} <label> <usd>  set the key's balance as the Console shows it and restart its spend count
  ${c.cyan("tokenmaxxing key rm")} <label>  delete the key and its stored secret (refused while a session runs on it)
  ${c.cyan("tokenmaxxing seat")} <pid>  lend one pooled Claude account to an unattended consumer until <pid> exits: prints the store directory to set as CLAUDE_SECURESTORAGE_CONFIG_DIR (the directory itself, as its owner, never a copy of its credential); host sessions and other borrowers share the account; exit 1 = none usable
  ${c.cyan("tokenmaxxing seat")} <pid> --store <id>  lend the Claude store with that 8-character id instead of the ranked pick, checking only that it is pooled, holds a usable credential, and is not flagged for reauthentication; bars, the credits flag, and holds are the caller's job; exit 0 = granted, 1 = the store is unusable, 2 = unknown store, <pid> already holds another store, or bad usage
  ${c.cyan("tokenmaxxing seat --codex")} <pid>  borrow one pooled codex account for an unattended consumer (plugin, script): prints the CODEX_HOME to set, lent to <pid> until it exits; codex sessions and other borrowers share the account, and a refresh race between them can sign it out until auth --codex runs again; exit 1 = none usable, fall back to the ambient login
  ${c.cyan("tokenmaxxing serve")}      serve the CLIProxyAPI-compatible usage API on http://localhost:<hub.port> (default 8317) so a dashboard such as T3 Code's "Add a CLIProxyAPI hub" shows every pooled Claude and Codex account's quota; the management key is the contents of hub-key in the state directory
  ${c.cyan("tokenmaxxing uninstall")} [--yes]  print the targets, then remove supervisor + settings entries (refused without ${c.cyan("--yes")} when HOME is the login home)

  ${c.cyan("--json")}                  print one JSON document on stdout instead of text (status, config, check); every document carries ${c.bold("ok")}, failures add ${c.bold("error")}
  ${c.cyan("--version")}               print the running package's version and exit (${c.cyan("-v")})

  ${c.dim("(aliased as")} ${c.cyan("xx")}${c.dim(")")} - then just run ${c.bold("claude")} as always; it switches accounts near quota automatically.`);
}

let jsonMode = false;

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
  if (argv0 === "pi" || argv[0] === "__supervise-pi") {
    return runPiSupervisor(argv[0] === "__supervise-pi" ? argv.slice(1) : argv);
  }

  jsonMode = argv.includes(JSON_FLAG);
  const json = jsonMode;
  const cached = argv.includes(CACHED_FLAG);
  const yes = argv.includes(YES_FLAG);
  const providerFlags = [CODEX_FLAG, GROK_FLAG].filter((f) => argv.includes(f));
  if (providerFlags.length > 1) {
    emitError({ json, message: `${providerFlags.join(" and ")} are mutually exclusive - pick one pool` });
    return 2;
  }
  const provider = argv.includes(CODEX_FLAG) ? codex : argv.includes(GROK_FLAG) ? grok : claude;
  const pi = argv.includes(PI_FLAG);
  const args = argv.filter((a) => a !== JSON_FLAG && a !== CACHED_FLAG && a !== YES_FLAG && a !== CODEX_FLAG && a !== GROK_FLAG && a !== PI_FLAG);
  const sub = args[0];

  if (pi && sub !== "init" && sub !== "auth") {
    emitError({ json, message: `${PI_FLAG} applies to init and auth, not ${sub ?? "status"}` });
    return 2;
  }

  if (pi && (sub === "init" ? provider !== claude : provider !== claude && provider !== codex)) {
    emitError({ json, message: sub === "init" ? `init ${PI_FLAG} takes no pool flag` : `auth ${PI_FLAG} logs a Claude account (no pool flag) or a codex account (${CODEX_FLAG}) into pi` });
    return 2;
  }

  if (cached && sub != null && sub !== "status") {
    emitError({ json, message: `${CACHED_FLAG} applies to status only, not ${sub}` });
    return 2;
  }

  if (yes && sub !== "uninstall") {
    emitError({ json, message: `${YES_FLAG} applies to uninstall only, not ${sub ?? "status"}` });
    return 2;
  }

  if (provider === codex && (sub == null || !CODEX_COMMANDS.has(sub))) {
    emitError({ json, message: `${CODEX_FLAG} applies to ${[...CODEX_COMMANDS].join(", ")}, not ${sub ?? "status"}` });
    return 2;
  }

  if (provider === grok && (sub == null || !STATUS_ONLY_COMMANDS.has(sub))) {
    emitError({ json, message: `${GROK_FLAG} applies to ${[...STATUS_ONLY_COMMANDS].join(", ")}, not ${sub ?? "status"}` });
    return 2;
  }

  if (json && sub != null && !JSON_COMMANDS.has(sub)) {
    emitError({ json, message: `${sub} has no ${JSON_FLAG} form (${JSON_FLAG} applies to ${[...JSON_COMMANDS].join(", ")})` });
    return 2;
  }

  const maxOperands = sub == null ? undefined : MAX_OPERANDS.get(sub);
  if (maxOperands != null && args.length - 1 > maxOperands) {
    emitError({ json, message: `${sub} takes at most ${count({ n: maxOperands, noun: "argument" })}, got: ${args.slice(1).join(" ")}` });
    return 2;
  }
  switch (sub) {
    case "__statusline": return runStatusline();
    case "__subagent-statusline": return runSubagentStatusline();
    case "__stop-hook": return runBoundaryHook("stop");
    case "__stop-failure-hook": return runStopFailureHook();
    case "__session-start": return runBoundaryHook("sessionstart");
    case "__codex-stop-hook": return runCodexStopHook();
    case undefined:
    case "status": {
      const extra = args[1];
      if (extra != null) {
        emitError({ json, message: `unknown status option: ${extra} (status takes only ${CACHED_FLAG})` });
        return 2;
      }
      return cmdStatus({ json, cached });
    }
    case "check": {
      if (args.length > 1) {
        emitError({ json, message: `unknown check option: ${args[1]} (check takes no options; the timer runs a plain check every tick)` });
        return 2;
      }
      return cmdCheck(json);
    }
    case "config": return cmdConfig(args.slice(1), json);
    case "init": return pi ? cmdInitPi() : cmdInit(provider);
    case "add": return cmdAdd(provider);
    case "auth": return cmdAuth(provider, args.slice(1), pi ? (provider === codex ? "codex" : "claude") : null);
    case "doctor": return cmdDoctor();
    case "rm": return cmdRm(provider, args[1]);
    case "rename": return cmdRename(provider, args.slice(1));
    case "key": return cmdKey(args.slice(1));
    case "seat": return cmdSeat(provider === codex ? "codex" : "claude", args.slice(1));
    case "serve": return cmdServe(args.slice(1));
    case "uninstall": {
      if (args.length > 1) {
        emitError({ message: `unknown uninstall option: ${args[1]} (uninstall takes only ${YES_FLAG})` });
        return 2;
      }
      const live = onLoginHome();
      console.log(`uninstall removes:\n${uninstallTargets(live).map((t) => `  ${t}`).join("\n")}`);
      if (live && !yes) {
        emitError({ message: `refused: HOME is the login home (${HOME}) - rerun with ${YES_FLAG} to remove these from the live install` });
        return 2;
      }
      const out = uninstallSupervisor({ live });
      const removed = [
        "supervisor wrapper",
        "settings entries",
        ...(out.timer === "removed" ? ["check timer"] : []),
        ...(out.hub === "removed" ? ["usage hub service"] : []),
        ...(out.pathLineRemoved ? ["rc PATH line"] : []),
      ];
      console.log(`removed ${removed.join(", ")}`);
      if (out.timer === "still-loaded") console.log(c.yellow(`⚠ the check job may still be loaded - run: ${deactivationHint(CHECK_JOB)}`));
      if (out.hub === "still-loaded") console.log(c.yellow(`⚠ the usage hub job may still be loaded - run: ${deactivationHint(HUB_JOB)}`));
      if (!out.pathLineRemoved) console.log(c.dim("(no tokenmaxxing PATH line found in the shell rc)"));
      console.log(`kept: accounts.json, config.json, and every account credential store (claude: stores/ and its keychain items on macOS; codex: codex-stores/; pi: pi-stores/; grok: grok-stores/), plus api-keys.json and the API keys in api-keys/ - remove accounts with \`xx rm\` and keys with \`xx key rm\` to delete their credentials`);
      return 0;
    }
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return 0;
    case "-v":
    case "--version":
      console.log(pkg.version);
      return 0;
    default:
      emitError({ message: `unknown command: ${sub}` });
      printHelp();
      return 2;
  }
}

try {
  process.exit(await main());
} catch (e) {
  emitError({ json: jsonMode, message: errorMessage(e) });
  process.exit(1);
}
