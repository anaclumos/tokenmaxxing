// `tokenmaxxing relay` - host-agnostic durable tmux relay companion.

import { cwd } from "node:process";
import { z } from "zod";
import { c } from "./render.ts";
import {
  DEFAULT_RELAY_CONFIG,
  loadRelayConfig,
  mergeRelayConfigFile,
  writeRelayConfig,
  type RelayConfigFile,
} from "../lib/relay/config.ts";
import { runDecide } from "../lib/relay/decide.ts";
import { destroySession, gcSessions, statusRows } from "../lib/relay/gc.ts";
import { installRelayHosts, type InstallTarget } from "../lib/relay/install.ts";
import { parsePermissionMode, tryParsePermissionMode } from "../lib/relay/modes.ts";
import { runTurn } from "../lib/relay/turn.ts";
import { setLivePermissionMode } from "../lib/relay/worker.ts";
import { existsSync, readFileSync } from "node:fs";
import { paths } from "../lib/paths.ts";

function printHelp(): void {
  console.log(`${c.bold("tokenmaxxing relay")} - durable tmux workers for host agents

  ${c.cyan("relay turn")} [--worker claude|codex] [--session <uuid>] [--cwd <dir>]
              [--permission-mode <mode>] [prompt...]
              Ensure session, send prompt (argv or stdin), wait for turn-done or permission-needed
  ${c.cyan("relay decide")} --session <uuid> [--request <id>] --approve|--deny [--no-wait]
              Approve or deny a pending permission ping; by default wait for the next marker
  ${c.cyan("relay set-permission-mode")} --session <uuid> --permission-mode <mode>
              Change the live worker permission mode
  ${c.cyan("relay status")} [--session <uuid>]
              Inspect relay sessions
  ${c.cyan("relay destroy")} --session <uuid>
              Tear down one session (exact tmux name)
  ${c.cyan("relay gc")}
              Reap dead or idle sessions (idleTtlMs)
  ${c.cyan("relay install")} [--target cursor|claude|all]
              Write agent templates and merge tokenmaxxing-owned hook keys
  ${c.cyan("relay config")} [get|set|show]
              Inspect or edit $TOKENMAXXING_HOME/relay.json

  Permission modes (Claude worker): default|acceptEdits|plan|auto|dontAsk|bypassPermissions
  Alias: manual → default. Default in relay.json: auto.
  Codex maps those names onto --sandbox / --ask-for-approval.`);
}

type FlagMap = {
  worker?: "claude" | "codex";
  session?: string;
  cwd?: string;
  permissionMode?: string;
  request?: string;
  approve?: boolean;
  deny?: boolean;
  noWait?: boolean;
  target?: string;
  positionals: string[];
};

function parseFlags(args: string[]): FlagMap {
  const out: FlagMap = { positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--worker") {
      const v = z.enum(["claude", "codex"]).parse(args[++i]);
      out.worker = v;
    } else if (a.startsWith("--worker=")) {
      out.worker = z.enum(["claude", "codex"]).parse(a.slice("--worker=".length));
    } else if (a === "--session") {
      out.session = z.string().min(1).parse(args[++i]);
    } else if (a.startsWith("--session=")) {
      out.session = a.slice("--session=".length);
    } else if (a === "--cwd") {
      out.cwd = z.string().min(1).parse(args[++i]);
    } else if (a.startsWith("--cwd=")) {
      out.cwd = a.slice("--cwd=".length);
    } else if (a === "--permission-mode") {
      out.permissionMode = z.string().min(1).parse(args[++i]);
    } else if (a.startsWith("--permission-mode=")) {
      out.permissionMode = a.slice("--permission-mode=".length);
    } else if (a === "--request") {
      out.request = z.string().min(1).parse(args[++i]);
    } else if (a.startsWith("--request=")) {
      out.request = a.slice("--request=".length);
    } else if (a === "--approve") {
      out.approve = true;
    } else if (a === "--deny") {
      out.deny = true;
    } else if (a === "--no-wait") {
      out.noWait = true;
    } else if (a === "--target") {
      out.target = z.string().min(1).parse(args[++i]);
    } else if (a.startsWith("--target=")) {
      out.target = a.slice("--target=".length);
    } else if (a === "--help" || a === "-h") {
      out.positionals.push(a);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      out.positionals.push(a);
    }
  }
  return out;
}

async function readPrompt(flags: FlagMap): Promise<string> {
  if (flags.positionals.length > 0) return flags.positionals.join(" ");
  if (process.stdin.isTTY) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdTurn(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (flags.positionals.includes("--help") || flags.positionals.includes("-h")) {
    printHelp();
    return 0;
  }
  const mode = flags.permissionMode != null
    ? parsePermissionMode({ raw: flags.permissionMode })
    : undefined;
  const prompt = await readPrompt(flags);
  const result = await runTurn({
    sessionId: flags.session,
    worker: flags.worker,
    permissionMode: mode,
    cwd: flags.cwd ?? cwd(),
    prompt,
  });
  process.stdout.write(result.stdout);
  return result.exitCode;
}

async function cmdDecide(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (flags.session == null) {
    console.error(c.red("relay decide requires --session <uuid>"));
    return 1;
  }
  if (flags.approve === true && flags.deny === true) {
    console.error(c.red("pass only one of --approve or --deny"));
    return 1;
  }
  if (flags.approve !== true && flags.deny !== true) {
    console.error(c.red("relay decide requires --approve or --deny"));
    return 1;
  }
  const result = await runDecide({
    sessionId: flags.session,
    requestId: flags.request,
    approve: flags.approve === true,
    wait: flags.noWait !== true,
    cwd: flags.cwd ?? cwd(),
  });
  if (result.turn != null) {
    process.stdout.write(result.turn.stdout);
    return result.turn.exitCode;
  }
  console.log(`decision written: ${result.requestId} (${flags.approve ? "approve" : "deny"})`);
  return 0;
}

async function cmdSetPermissionMode(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (flags.session == null || flags.permissionMode == null) {
    console.error(c.red("relay set-permission-mode requires --session and --permission-mode"));
    return 1;
  }
  const mode = parsePermissionMode({ raw: flags.permissionMode });
  const entry = await setLivePermissionMode({ sessionId: flags.session, permissionMode: mode });
  console.log(`session: ${entry.sessionId}`);
  console.log(`permission-mode: ${entry.permissionMode}`);
  return 0;
}

function cmdStatus(args: string[]): number {
  const flags = parseFlags(args);
  const rows = statusRows();
  const filtered = flags.session != null
    ? rows.filter((r) => r.sessionId === flags.session)
    : rows;
  if (filtered.length === 0) {
    console.log(c.dim("(no relay sessions)"));
    return 0;
  }
  for (const row of filtered) {
    const alive = row.tmuxAlive ? c.green("up") : c.red("down");
    console.log(
      `${row.sessionId}  ${row.worker}  ${row.permissionMode}  ${row.state}  tmux=${alive}  ${row.tmuxName}`,
    );
  }
  return 0;
}

async function cmdDestroy(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (flags.session == null) {
    console.error(c.red("relay destroy requires --session <uuid>"));
    return 1;
  }
  const ok = await destroySession({ sessionId: flags.session });
  if (!ok) {
    console.error(c.red(`relay session not found: ${flags.session}`));
    return 1;
  }
  console.log(`destroyed ${flags.session}`);
  return 0;
}

async function cmdGc(): Promise<number> {
  const result = await gcSessions();
  console.log(`reaped ${result.reaped.length}; kept ${result.kept.length}`);
  for (const id of result.reaped) console.log(`  reaped ${id}`);
  return 0;
}

function cmdInstall(args: string[]): number {
  const flags = parseFlags(args);
  const target = z.enum(["cursor", "claude", "all"]).catch("all").parse(flags.target ?? "all") as InstallTarget;
  const result = installRelayHosts({ target });
  console.log(`agents: ${result.agentsWritten.length}`);
  for (const p of result.agentsWritten) console.log(`  ${p}`);
  console.log(`skill: ${result.skillWritten ? "written" : "skipped"}`);
  console.log(`hooks: ${result.hooksMerged.length}`);
  for (const p of result.hooksMerged) console.log(`  ${p}`);
  return 0;
}

function cmdConfig(args: string[]): number {
  const sub = args[0] ?? "show";
  if (sub === "show" || sub === "get" && args[1] == null) {
    const cfg = loadRelayConfig();
    console.log(c.dim(`relay.json: ${paths.relayJson}`));
    console.log(JSON.stringify(cfg, null, 2));
    return 0;
  }
  if (sub === "get") {
    const key = args[1];
    if (key == null) {
      console.error(c.red("relay config get <key>"));
      return 1;
    }
    const cfg = loadRelayConfig() as Record<string, unknown>;
    if (!(key in cfg)) {
      console.error(c.red(`unknown key: ${key}`));
      return 1;
    }
    console.log(JSON.stringify(cfg[key]));
    return 0;
  }
  if (sub === "set") {
    const key = args[1];
    const valueText = args[2];
    if (key == null || valueText == null) {
      console.error(c.red("relay config set <key> <value>"));
      return 1;
    }
    let value: unknown;
    try {
      value = JSON.parse(valueText);
    } catch {
      value = valueText;
    }
    if (key === "defaultPermissionMode") {
      const mode = tryParsePermissionMode({ raw: String(value) });
      if (mode == null) {
        console.error(c.red(`invalid permission mode: ${value}`));
        return 1;
      }
      value = mode;
    }
    const patch = { [key]: value } as RelayConfigFile;
    const next = mergeRelayConfigFile({ patch });
    console.log(`${key}: ${JSON.stringify((next as Record<string, unknown>)[key])}`);
    return 0;
  }
  if (sub === "init") {
    if (!existsSync(paths.relayJson)) {
      writeRelayConfig({ file: {} });
      console.log(`wrote defaults-capable ${paths.relayJson}`);
    } else {
      console.log(`already exists: ${paths.relayJson}`);
      console.log(readFileSync(paths.relayJson, "utf8"));
    }
    console.log(c.dim(`effective defaultPermissionMode=${DEFAULT_RELAY_CONFIG.defaultPermissionMode}`));
    return 0;
  }
  console.error(c.red(`unknown relay config subcommand: ${sub}`));
  return 1;
}

export async function cmdRelay(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub == null || sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return 0;
  }
  const rest = args.slice(1);
  switch (sub) {
    case "turn":
      return cmdTurn(rest);
    case "decide":
      return cmdDecide(rest);
    case "set-permission-mode":
      return cmdSetPermissionMode(rest);
    case "status":
      return cmdStatus(rest);
    case "destroy":
      return cmdDestroy(rest);
    case "gc":
      return cmdGc();
    case "install":
      return cmdInstall(rest);
    case "config":
      return cmdConfig(rest);
    default:
      console.error(c.red(`unknown relay command: ${sub}`));
      printHelp();
      return 2;
  }
}
