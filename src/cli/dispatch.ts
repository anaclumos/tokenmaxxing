import { basename } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runSupervisor } from "../entries/supervisor.ts";
import { runStatusline } from "../entries/statusline.ts";
import { runSubagentStatusline } from "../entries/subagentstatusline.ts";
import { runStopHook } from "../entries/stophook.ts";
import { runStopFailureHook } from "../entries/stopfailurehook.ts";
import { runSessionStart } from "../entries/sessionstart.ts";
import { cmdInit } from "./init.ts";
import { cmdAdd } from "./add.ts";
import { cmdAuth } from "./auth.ts";
import { cmdCodexAdd } from "./codexadd.ts";
import { cmdCodexInit } from "./codexinit.ts";
import { cmdCodexSwitch } from "./codexswitch.ts";
import { runCodexSupervisor } from "../entries/codexsupervisor.ts";
import { runCodexStopHook } from "../entries/codexstophook.ts";
import { cmdLs } from "./ls.ts";
import { cmdStatus } from "./status.ts";
import { cmdWatch } from "./watch.ts";
import { cmdDoctor } from "./doctor.ts";
import { cmdRm } from "./rm.ts";
import { cmdCodexRm } from "./codexrm.ts";
import { cmdRename } from "./rename.ts";
import { cmdSwitch } from "./switch.ts";
import { cmdCheck } from "./check.ts";
import { cmdConfig } from "./config.ts";
import { timerDeactivationHint, uninstallSupervisor } from "../lib/install.ts";
import { errorMessage } from "../lib/errors.ts";
import { ambientStoreDir } from "../lib/paths.ts";
import { c, emitError, emitJson } from "./render.ts";

const INTERACTIVE_COMMANDS = new Set(["init", "add", "auth"]);

const COMMANDS: Record<string, { flags: string[]; positionals: number }> = {
  status: { flags: ["ping", "count"], positionals: 0 },
  switch: { flags: ["codex"], positionals: 1 },
  check: { flags: ["if-due"], positionals: 0 },
  config: { flags: [], positionals: Number.POSITIVE_INFINITY },
  init: { flags: ["codex"], positionals: 0 },
  add: { flags: ["codex"], positionals: 0 },
  auth: { flags: ["all"], positionals: 1 },
  ls: { flags: [], positionals: 0 },
  watch: { flags: [], positionals: 1 },
  doctor: { flags: [], positionals: 0 },
  rm: { flags: ["codex"], positionals: 1 },
  rename: { flags: ["codex"], positionals: 2 },
  uninstall: { flags: [], positionals: 0 },
  help: { flags: [], positionals: 0 },
};

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

function parseCli(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      codex: { type: "boolean" },
      ping: { type: "boolean" },
      count: { type: "string", multiple: true },
      "if-due": { type: "boolean" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
}

const CountSchema = z.coerce.number().int().min(1);

function statusFlags(values: { ping?: boolean; count?: string[] }): { ping: boolean; pingCount: number | undefined } | { error: string } {
  const ping = values.ping === true;
  const counts = values.count ?? [];
  if (counts.length > 1) return { error: "--count may only be given once" };
  if (counts.length === 0) return { ping, pingCount: undefined };
  if (!ping) return { error: "--count only applies together with --ping" };
  const count = CountSchema.safeParse(counts[0]);
  if (!count.success) return { error: `--count needs a positive whole number of accounts, got: ${counts[0]}` };
  return { ping, pingCount: count.data };
}

export async function dispatch(): Promise<number> {
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

  let cli: ReturnType<typeof parseCli>;
  try {
    cli = parseCli(argv);
  } catch (e) {
    emitError({ json: argv.includes("--json"), message: errorMessage(e) });
    return 2;
  }
  const { values, positionals } = cli;
  const json = values.json === true;
  const codex = values.codex === true;
  const sub = positionals[0];
  const rest = positionals.slice(1);

  const command = sub ?? "status";
  const spec = COMMANDS[command];
  if (spec != null) {
    const allowed = new Set(["json", "help", ...spec.flags]);
    const stray = Object.keys(values).find((flag) => !allowed.has(flag));
    if (stray != null) {
      emitError({ json, message: `--${stray} does not apply to ${command}` });
      return 2;
    }
    if (rest.length > spec.positionals) {
      emitError({ json, message: `too many arguments for ${command}: ${rest.slice(spec.positionals).join(" ")}` });
      return 2;
    }
  }
  if (json && sub != null && INTERACTIVE_COMMANDS.has(sub)) {
    emitError({ json, message: `${sub} is interactive (it runs a login flow) and has no --json form` });
    return 2;
  }
  if (!(sub != null && sub.startsWith("__")) && !process.env.TOKENMAXXING_PROBE) {
    const ambient = ambientStoreDir();
    if (ambient != null) {
      emitError({
        json,
        message: `CLAUDE_CONFIG_DIR / CLAUDE_SECURESTORAGE_CONFIG_DIR is set (${ambient.value}): claude uses a namespaced credential store there that tokenmaxxing does not manage - unset it (or run from a clean shell) and retry.`,
      });
      return 1;
    }
  }
  if (values.help === true) {
    printHelp();
    return 0;
  }

  switch (sub) {
    case "__statusline": return runStatusline();
    case "__subagent-statusline": return runSubagentStatusline();
    case "__stop-hook": return runStopHook();
    case "__stop-failure-hook": return runStopFailureHook();
    case "__session-start": return runSessionStart();
    case "__codex-stop-hook": return runCodexStopHook();
    case undefined:
    case "status": {
      const flags = statusFlags(values);
      if ("error" in flags) {
        emitError({ json, message: flags.error });
        return 2;
      }
      return cmdStatus({ ...flags, json });
    }
    case "switch": return codex ? cmdCodexSwitch(rest[0], json) : cmdSwitch(rest[0], json);
    case "check": return cmdCheck({ ifDue: values["if-due"] === true, json });
    case "config": return cmdConfig(rest, json);
    case "init": return codex ? cmdCodexInit() : cmdInit();
    case "add": return codex ? cmdCodexAdd() : cmdAdd();
    case "auth": return cmdAuth({ all: values.all === true, rest });
    case "ls": return cmdLs(json);
    case "watch": return cmdWatch(rest[0], json);
    case "doctor": return cmdDoctor(json);
    case "rm": return codex ? cmdCodexRm(rest[0], json) : cmdRm(rest[0], json);
    case "rename": return cmdRename({ selector: rest[0], newLabel: rest[1], codex, json });
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
      printHelp();
      return 0;
    default:
      emitError({ json, message: `unknown command: ${sub}` });
      if (!json) printHelp();
      return 2;
  }
}
