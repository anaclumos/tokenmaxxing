import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { childEnv, freshHomes, type Homes } from "./edge-telemetry-fixtures.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const UNREACHABLE_HOST = "http://127.0.0.1:9";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CHILD_LAUNCH = "child-launch";

const RECORDER = `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const env = process.env;
appendFileSync(env.EDGE_LAUNCHES, JSON.stringify({ argv: process.argv.slice(2), env }) + "\\n");
const launches = readFileSync(env.EDGE_LAUNCHES, "utf8").split("\\n").filter((line) => line !== "").length;
if (env.EDGE_MARKER_TEXT !== undefined && launches === 1) {
  const dir = join(env.TOKENMAXXING_HOME, "respawn");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, env.TOKENMAXXING_SESSION_ID), env.EDGE_MARKER_TEXT.replaceAll('"${CHILD_LAUNCH}"', env.TOKENMAXXING_LAUNCHED_AT));
}
process.exit(Number(env.EDGE_EXIT ?? "0"));
`;

const LaunchSchema = z.object({ argv: z.array(z.string()), env: z.record(z.string(), z.string()) });
export type Launch = z.infer<typeof LaunchSchema>;

export type Sandbox = Homes & { project: string };

export type Run = { exitCode: number; stdout: string; stderr: string; launches: Launch[] };

function fakeTool(dir: string, name: string, recorder: string): string {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

export function supervisorSandbox(): Sandbox {
  const homes = freshHomes();
  const project = realpathSync(mkdtempSync(join(tmpdir(), "tokenmaxxing-edge-project-")));
  const tools = join(homes.home, "real-tools");
  mkdirSync(tools, { recursive: true });
  const recorder = join(tools, "recorder.mjs");
  writeFileSync(recorder, RECORDER);
  const config = { claudeBin: fakeTool(tools, "claude", recorder), codexBin: fakeTool(tools, "codex", recorder), telemetry: false };
  writeFileSync(join(homes.state, "config.json"), JSON.stringify(config));
  return { ...homes, project };
}

function supervisorEnv(s: Sandbox, launches: string, extra: Record<string, string | undefined>): Record<string, string> {
  return childEnv(s, UNREACHABLE_HOST, {
    CLAUDE_CONFIG_DIR: join(s.home, ".claude"),
    TOKENMAXXING_CLAUDE_SETTINGS: join(s.home, ".claude", "settings.json"),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined,
    CODEX_HOME: undefined,
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
    EDGE_LAUNCHES: launches,
    ...extra,
  });
}

function launchesIn(file: string): Launch[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => LaunchSchema.parse(JSON.parse(line)));
}

export async function supervise(s: Sandbox, entry: "__supervise" | "__supervise-codex", args: string[], extra: Record<string, string | undefined> = {}): Promise<Run> {
  const launches = join(s.home, `launches-${crypto.randomUUID()}.jsonl`);
  const proc = Bun.spawn([process.execPath, MAIN, entry, ...args], {
    env: supervisorEnv(s, launches, extra),
    cwd: s.project,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr, launches: launchesIn(launches) };
}

export async function statusline(s: Sandbox, stdin: unknown): Promise<Run> {
  const proc = Bun.spawn([process.execPath, MAIN, "__statusline"], {
    env: supervisorEnv(s, join(s.home, "statusline-launches.jsonl"), {}),
    cwd: s.project,
    stdin: new Blob([JSON.stringify(stdin)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr, launches: [] };
}

export function writeTranscript(s: Sandbox, sessionId: string, modifiedAt: number): void {
  const dir = join(s.home, ".claude", "projects", s.project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "user", sessionId, cwd: s.project, message: { role: "user", content: "fix the failing test" } })}\n`);
  utimesSync(file, modifiedAt / 1000, modifiedAt / 1000);
}

export function launchSummary(run: Run): { exitCode: number; launches: { argv: string[]; sessionId: string | null }[]; stderr: string } {
  return { exitCode: run.exitCode, launches: run.launches.map((l) => ({ argv: l.argv, sessionId: l.env.TOKENMAXXING_SESSION_ID ?? null })), stderr: run.stderr };
}
