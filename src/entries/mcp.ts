// Stdio MCP entry for the portable Agent Plugin (agent-plugin/).
// Tools wrap existing CLI commands. stdout is reserved for MCP JSON-RPC, so
// every CLI call captures console.log / console.error and returns the text.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cmdLs } from "../cli/ls.ts";
import { cmdStatus } from "../cli/status.ts";
import { cmdDoctor } from "../cli/doctor.ts";
import { cmdConfig } from "../cli/config.ts";
import { cmdSwitch } from "../cli/switch.ts";
import { cmdCodexSwitch } from "../cli/codexswitch.ts";
import { cmdCheck } from "../cli/check.ts";

const MUTATIONS_ENV = "TOKENMAXXING_AGENT_MUTATIONS";
const PACKAGE_ROOT = join(import.meta.dir, "../..");

function packageVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string };
    return raw.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Refuse ambient Claude store overrides the same way the CLI and SDK do. */
export function refuseAmbientStoreEnv(): string | null {
  const nonEmpty = (v: string | undefined) => (v != null && v !== "" ? v : null);
  return nonEmpty(process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR) ?? nonEmpty(process.env.CLAUDE_CONFIG_DIR);
}

/** Redact token-shaped spans so tool results never echo credentials. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._\-+/=]+/gi, "$1[redacted]")
    .replace(/\b(sk-ant-[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/\b(accessToken|refreshToken|claudeAiOauth)\b\s*[:=]\s*["']?[^"'}\s,]+/gi, "$1=[redacted]");
}

type CaptureResult = { code: number; stdout: string; stderr: string };

/** Run a CLI cmd while keeping stdout clean for the MCP transport. */
export async function captureCli(run: () => number | Promise<number>): Promise<CaptureResult> {
  const out: string[] = [];
  const err: string[] = [];
  const joinArgs = (args: unknown[]) => args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { out.push(joinArgs(args)); };
  console.error = (...args: unknown[]) => { err.push(joinArgs(args)); };
  try {
    const code = await run();
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function textResult(input: { text: string; isError?: boolean }) {
  return {
    content: [{ type: "text" as const, text: scrubSecrets(input.text) }],
    ...(input.isError ? { isError: true } : {}),
  };
}

function formatCapture(cap: CaptureResult): string {
  const parts: string[] = [];
  if (cap.stdout) parts.push(cap.stdout);
  if (cap.stderr) parts.push(cap.stderr);
  parts.push(`exit ${cap.code}`);
  return parts.join("\n").trimEnd();
}

export function mutationsEnabled(): boolean {
  return process.env[MUTATIONS_ENV] === "1";
}

function mutationDenied(confirm: boolean): string | null {
  if (!confirm) {
    return `Mutating tools require confirm=true. Also set ${MUTATIONS_ENV}=1 in the MCP server environment after the user approves.`;
  }
  if (!mutationsEnabled()) {
    return `Mutations are disabled. Set ${MUTATIONS_ENV}=1 in the MCP server environment only after the user explicitly approves a pool mutation.`;
  }
  return null;
}

const HELP_TEXT = `tokenmaxxing agent MCP

Read tools (always available):
  pool_ls       list pooled Claude and Codex accounts (labels/status only)
  pool_status   sample usage bars (free /usage path; never --force)
  doctor        verify install health (labels/status only)
  config_get    read effective config, or one key when provided
  help          this catalog

Mutating tools (confirm=true AND ${MUTATIONS_ENV}=1):
  pool_switch   Claude greedy/forced switch, or Codex when codex=true
  pool_check    one evaluate-and-maybe-swap pass
  config_set    write a config.json override
  config_unset  remove a config.json override

Hard deny (no tools):
  status --force / metered pings
  init / add / auth / rm / uninstall
  serve / Slack posts
  credential blobs or token values
  killing sessions or supervisors

Prefer these tools over raw shell for pool ops. Honor TOKENMAXXING_HOME for hermetic use.
The Slack serve Claude plugin (src/serve-plugin/) is separate: session skills for daemon-relayed threads, not this portable package.
`;

export function createTokenmaxxingMcpServer(): McpServer {
  const server = new McpServer({
    name: "tokenmaxxing",
    version: packageVersion(),
  });

  server.registerTool(
    "help",
    {
      description: "Catalog of tokenmaxxing MCP tools and hard safety rules. Use when deciding which pool tool to call.",
      inputSchema: {},
    },
    async () => textResult({ text: HELP_TEXT }),
  );

  server.registerTool(
    "pool_ls",
    {
      description: "List pooled Claude and Codex accounts with active and needs-reauth flags. Labels and status only; never credential material.",
      inputSchema: {},
    },
    async () => {
      const cap = await captureCli(() => cmdLs());
      return textResult({ text: formatCapture(cap), isError: cap.code !== 0 });
    },
  );

  server.registerTool(
    "pool_status",
    {
      description: "Show pool usage bars via the free /usage path. Never opens 5h windows. Do not request --force; that tool does not exist.",
      inputSchema: {},
    },
    async () => {
      const cap = await captureCli(() => cmdStatus(false));
      return textResult({ text: formatCapture(cap), isError: cap.code !== 0 });
    },
  );

  server.registerTool(
    "doctor",
    {
      description: "Verify supervisor, hooks, timer, and credential identity health. Reports labels and pass/fail only; never returns credential blobs.",
      inputSchema: {},
    },
    async () => {
      const cap = await captureCli(() => cmdDoctor());
      return textResult({ text: formatCapture(cap), isError: cap.code !== 0 });
    },
  );

  server.registerTool(
    "config_get",
    {
      description: "Read effective config with sources, or one dotted key when key is set (e.g. thresholds.session).",
      inputSchema: {
        key: z.string().optional().describe("Optional dotted config key; omit for the full effective table"),
      },
    },
    async ({ key }) => {
      const args = key ? ["get", key] : [];
      const cap = await captureCli(() => cmdConfig(args));
      return textResult({ text: formatCapture(cap), isError: cap.code !== 0 });
    },
  );

  server.registerTool(
    "pool_switch",
    {
      description: "Switch the Claude pool (or Codex when codex=true). Requires confirm=true and TOKENMAXXING_AGENT_MUTATIONS=1. Hot-swaps live Claude; Codex takes effect on next start.",
      inputSchema: {
        confirm: z.boolean().describe("Must be true after the user approves the mutation"),
        selector: z.string().optional().describe("Optional account selector; omit for greedy best"),
        codex: z.boolean().optional().describe("When true, run the Codex pool switch instead"),
      },
    },
    async ({ confirm, selector, codex }) => {
      const denied = mutationDenied(confirm);
      if (denied) return textResult({ text: denied, isError: true });
      const cap = await captureCli(() => (codex ? cmdCodexSwitch(selector) : cmdSwitch(selector)));
      return textResult({ text: formatCapture(cap), isError: cap.code !== 0 });
    },
  );

  server.registerTool(
    "pool_check",
    {
      description: "Run one evaluate-and-maybe-swap pass (the periodic timer path). Requires confirm=true and TOKENMAXXING_AGENT_MUTATIONS=1.",
      inputSchema: {
        confirm: z.boolean().describe("Must be true after the user approves the mutation"),
      },
    },
    async ({ confirm }) => {
      const denied = mutationDenied(confirm);
      if (denied) return textResult({ text: denied, isError: true });
      const cap = await captureCli(() => cmdCheck());
      return textResult({ text: formatCapture(cap), isError: cap.code !== 0 });
    },
  );

  server.registerTool(
    "config_set",
    {
      description: "Write a config.json override. Requires confirm=true and TOKENMAXXING_AGENT_MUTATIONS=1.",
      inputSchema: {
        confirm: z.boolean().describe("Must be true after the user approves the mutation"),
        key: z.string().describe("Dotted config key"),
        value: z.string().describe("JSON or literal string value"),
      },
    },
    async ({ confirm, key, value }) => {
      const denied = mutationDenied(confirm);
      if (denied) return textResult({ text: denied, isError: true });
      const cap = await captureCli(() => cmdConfig(["set", key, value]));
      return textResult({ text: formatCapture(cap), isError: cap.code !== 0 });
    },
  );

  server.registerTool(
    "config_unset",
    {
      description: "Remove a config.json override. Requires confirm=true and TOKENMAXXING_AGENT_MUTATIONS=1.",
      inputSchema: {
        confirm: z.boolean().describe("Must be true after the user approves the mutation"),
        key: z.string().describe("Dotted config key"),
      },
    },
    async ({ confirm, key }) => {
      const denied = mutationDenied(confirm);
      if (denied) return textResult({ text: denied, isError: true });
      const cap = await captureCli(() => cmdConfig(["unset", key]));
      return textResult({ text: formatCapture(cap), isError: cap.code !== 0 });
    },
  );

  return server;
}

async function main(): Promise<void> {
  const ambient = refuseAmbientStoreEnv();
  if (ambient != null) {
    console.error(
      `CLAUDE_CONFIG_DIR / CLAUDE_SECURESTORAGE_CONFIG_DIR is set (${ambient}): the pooled MCP surface requires the default Claude Code credential store. Unset it and retry.`,
    );
    process.exit(1);
  }
  const server = createTokenmaxxingMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("tokenmaxxing MCP server running on stdio");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
