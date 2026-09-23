#!/usr/bin/env bun

import { basename } from "node:path";
import { runSupervisor } from "./entries/supervisor.ts";
import { runStatusline } from "./entries/statusline.ts";
import { runSubagentStatusline } from "./entries/subagentstatusline.ts";
import { runBoundaryHook } from "./entries/stophook.ts";
import { runStopFailureHook } from "./entries/stopfailurehook.ts";
import { runCodexSupervisor } from "./entries/codexsupervisor.ts";
import { runCodexStopHook } from "./entries/codexstophook.ts";
import { claude } from "./lib/claude.ts";
import { codex } from "./lib/codex.ts";
import { grok } from "./lib/grok.ts";
import { opencodeGo } from "./lib/opencodego.ts";
import { cmdInit } from "./cli/init.ts";
import { cmdAdd } from "./cli/add.ts";
import { cmdAuth } from "./cli/auth.ts";
import { cmdStatus } from "./cli/status.ts";
import { cmdDoctor } from "./cli/doctor.ts";
import { cmdRm } from "./cli/rm.ts";
import { cmdRename } from "./cli/rename.ts";
import { cmdCheck } from "./cli/check.ts";
import { cmdConfig } from "./cli/config.ts";
import { cmdSeat } from "./cli/seat.ts";
import { cmdServe } from "./cli/serve.ts";
import { hubDeactivationHint, onLoginHome, timerDeactivationHint, uninstallSupervisor, uninstallTargets } from "./lib/install.ts";
import { errorMessage } from "./lib/log.ts";
import { HOME } from "./lib/paths.ts";
import { c, emitError } from "./cli/render.ts";

const JSON_FLAG = "--json";
const CACHED_FLAG = "--cached";
const YES_FLAG = "--yes";
const CODEX_FLAG = "--codex";
const GROK_FLAG = "--grok";
const OPENCODE_GO_FLAG = "--opencode-go";
const JSON_COMMANDS = new Set(["status", "config", "check"]);
const CODEX_COMMANDS = new Set(["init", "add", "auth", "rm", "rename", "seat"]);
const STATUS_ONLY_COMMANDS = new Set(["init", "add", "auth", "rm", "rename"]);

function printHelp(): void {
  console.log(`${c.bold("tokenmaxxing")} - automatic Claude Code account switching

  ${c.cyan("tokenmaxxing")}            show the pool with usage bars (alias of ${c.cyan("status")})
  ${c.cyan("tokenmaxxing check")}      sample up to three accounts whose last usage attempts are oldest (run by the periodic timer)
  ${c.cyan("tokenmaxxing init")}       log in the first account (isolated) + install supervisor & hooks
  ${c.cyan("tokenmaxxing init --codex")}  same for codex: log in the first account, isolated, install codex supervisor + Stop hook
  ${c.cyan("tokenmaxxing init --grok")}   pool grok Build logins (status-only: no supervisor yet)
  ${c.cyan("tokenmaxxing init --opencode-go")}  pool opencode-go API keys (status-only: no supervisor yet)
  ${c.cyan("tokenmaxxing add")}        register an additional account (isolated login)
  ${c.cyan("tokenmaxxing add")} --codex | --grok | --opencode-go   same for the codex, grok, or opencode-go pool
  ${c.cyan("tokenmaxxing auth")} [--codex | --grok | --opencode-go] [sel | --all]  reauthenticate a pooled account in place (bare = pick from a list; --all = every account that is flagged or has no usable credential in its store, one by one)
  ${c.cyan("tokenmaxxing status")} [--cached]  accounts with 5h / weekly / per-model usage bars (--cached: the stored figures, no sampling)
  ${c.cyan("tokenmaxxing config")}     print the config path and the effective values (edit the file in an editor)
  ${c.cyan("tokenmaxxing doctor")}     verify the install is intact
  ${c.cyan("tokenmaxxing rename")} [--codex | --grok | --opencode-go] <sel> <label>
  ${c.cyan("tokenmaxxing rm")} [--codex | --grok | --opencode-go] <sel>
  ${c.cyan("tokenmaxxing seat --codex")} <pid>  borrow one pooled codex account for an unattended consumer (plugin, script): prints the CODEX_HOME to set, reserved until <pid> exits; exit 1 = none usable, fall back to the ambient login
  ${c.cyan("tokenmaxxing serve")}      serve the CLIProxyAPI-compatible usage API on http://localhost:<hub.port> (default 8317) so a dashboard such as T3 Code's "Add a CLIProxyAPI hub" shows every pooled Claude and Codex account's quota; the management key is the contents of hub-key in the state directory
  ${c.cyan("tokenmaxxing uninstall")} [--yes]  print the targets, then remove supervisor + settings entries (refused without ${c.cyan("--yes")} when HOME is the login home)

  ${c.cyan("--json")}                  print one JSON document on stdout instead of text (status, config, check); every document carries ${c.bold("ok")}, failures add ${c.bold("error")}

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

  jsonMode = argv.includes(JSON_FLAG);
  const json = jsonMode;
  const cached = argv.includes(CACHED_FLAG);
  const yes = argv.includes(YES_FLAG);
  const providerFlags = [CODEX_FLAG, GROK_FLAG, OPENCODE_GO_FLAG].filter((f) => argv.includes(f));
  if (providerFlags.length > 1) {
    emitError({ json, message: `${providerFlags.join(" and ")} are mutually exclusive - pick one pool` });
    return 2;
  }
  const provider = argv.includes(CODEX_FLAG) ? codex : argv.includes(GROK_FLAG) ? grok : argv.includes(OPENCODE_GO_FLAG) ? opencodeGo : claude;
  const args = argv.filter((a) => a !== JSON_FLAG && a !== CACHED_FLAG && a !== YES_FLAG && a !== CODEX_FLAG && a !== GROK_FLAG && a !== OPENCODE_GO_FLAG);
  const sub = args[0];

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

  if ((provider === grok || provider === opencodeGo) && (sub == null || !STATUS_ONLY_COMMANDS.has(sub))) {
    const flag = provider === grok ? GROK_FLAG : OPENCODE_GO_FLAG;
    emitError({ json, message: `${flag} applies to ${[...STATUS_ONLY_COMMANDS].join(", ")}, not ${sub ?? "status"}` });
    return 2;
  }

  if (json && sub != null && !JSON_COMMANDS.has(sub)) {
    emitError({ json, message: `${sub} has no ${JSON_FLAG} form (${JSON_FLAG} applies to ${[...JSON_COMMANDS].join(", ")})` });
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
    case "init": return cmdInit(provider);
    case "add": return cmdAdd(provider);
    case "auth": return cmdAuth(provider, args.slice(1));
    case "doctor": return cmdDoctor();
    case "rm": return cmdRm(provider, args[1]);
    case "rename": return cmdRename(provider, args.slice(1));
    case "seat": {
      if (provider !== codex) {
        emitError({ message: `seat borrows a pooled codex account - pass ${CODEX_FLAG} (usage: tokenmaxxing seat ${CODEX_FLAG} <pid>)` });
        return 2;
      }
      return cmdSeat(args[1], args.slice(2));
    }
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
      if (out.timer === "still-loaded") console.log(c.yellow(`⚠ the check job may still be loaded - run: ${timerDeactivationHint()}`));
      if (out.hub === "still-loaded") console.log(c.yellow(`⚠ the usage hub job may still be loaded - run: ${hubDeactivationHint()}`));
      if (!out.pathLineRemoved) console.log(c.dim("(no tokenmaxxing PATH line found in the shell rc)"));
      console.log(`kept: accounts.json, config.json, and every account credential store (claude: stores/ and its keychain items on macOS; codex: codex-stores/; grok: grok-stores/; opencode-go: opencode-go-stores/) - remove accounts with \`xx rm\` to delete their credentials`);
      return 0;
    }
    case "help":
    case "-h":
    case "--help":
      printHelp();
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
