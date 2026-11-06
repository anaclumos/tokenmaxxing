import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { account, HOUR_MS, sessionWindow, weeklyWindow } from "./fixtures.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

export type Sandbox = { root: string; tm: string };

export function sandbox(name: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `tokenmaxxing-edge-compat-${name}-`));
  const tm = join(root, "tokenmaxxing");
  mkdirSync(tm, { recursive: true });
  return { root, tm };
}

export function dropSandbox(box: Sandbox): void {
  rmSync(box.root, { recursive: true, force: true });
}

export function cleanEnv(box: Sandbox, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("TOKENMAXXING_") && !key.startsWith("CLAUDE_")) env[key] = value;
  }
  return { ...env, HOME: box.root, TOKENMAXXING_HOME: box.tm, TOKENMAXXING_SKIP_TIMER: "1", DO_NOT_TRACK: "1", ...extra };
}

export function spentSeatWithSpareKey(tm: string, now: number): string {
  mkdirSync(join(tm, "api-keys"), { recursive: true });
  const id = crypto.randomUUID();
  const seat = { ...account(id, "max 5x", [sessionWindow(40, now + 2 * HOUR_MS, now), weeklyWindow(99, now + 3 * 24 * HOUR_MS, now)]), lastUsageAt: now, lastProbeAt: now };
  writeFileSync(join(tm, "accounts.json"), JSON.stringify({ version: 2, accounts: [seat] }));
  writeFileSync(join(tm, "api-keys.json"), JSON.stringify({ version: 1, keys: [{ id: "spare", label: "spare", spentUsd: 0, addedAt: now }], baselines: {} }));
  writeFileSync(join(tm, "api-keys", "spare"), "sk-ant-test\n", { mode: 0o600 });
  return id;
}

export function seatSessionEnv(box: Sandbox, input: { seatId: string; sid: string; extra: Record<string, string> }): Record<string, string> {
  return cleanEnv(box, {
    CLAUDE_SECURESTORAGE_CONFIG_DIR: join(box.tm, "stores", input.seatId.slice(0, 8)),
    TOKENMAXXING_SUPERVISED: "1",
    TOKENMAXXING_SESSION_ID: input.sid,
    TOKENMAXXING_MODEL: "",
    TOKENMAXXING_REFUSED: "",
    ...input.extra,
  });
}

export type Run = { exitCode: number; stdout: string; stderr: string };

export async function runMain(input: { args: string[]; env: Record<string, string>; cwd: string; stdin?: string }): Promise<Run> {
  const proc = Bun.spawn([process.execPath, MAIN, ...input.args], {
    env: input.env,
    cwd: input.cwd,
    stdin: input.stdin == null ? "ignore" : new TextEncoder().encode(input.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, proc.stdout.text(), proc.stderr.text()]);
  return { exitCode, stdout, stderr };
}

export function readMarker(tm: string, sid: string): unknown {
  const path = join(tm, "respawn", sid);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export function readLog(tm: string): string {
  const path = join(tm, "tokenmaxxing.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
