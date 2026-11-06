import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(tm, "api-keys.json"), JSON.stringify({ version: 1, keys: [{ id: "spare", label: "spare", spentUsd: 0, creditSetAt: now, addedAt: now }], baselines: {} }));
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

const FAKE_CLAUDE = `#!/bin/sh
printf '%s\\n' "$TOKENMAXXING_LAUNCHED_AT $*" >> "$EDGE_LAUNCHES"
[ -e "$EDGE_MARKED" ] && exit 0
: > "$EDGE_MARKED"
case "$EDGE_MARKER_LAUNCH" in
  same) launch=",\\"launchedAt\\":$TOKENMAXXING_LAUNCHED_AT" ;;
  earlier) launch=",\\"launchedAt\\":$((TOKENMAXXING_LAUNCHED_AT - 60000))" ;;
  *) launch="" ;;
esac
printf '{"accountId":"","ts":%s,"waitUntil":0,"sessionId":"%s","compact":false,"origin":"stop"%s}' "$TOKENMAXXING_LAUNCHED_AT" "$TOKENMAXXING_SESSION_ID" "$launch" > "$EDGE_STAGED"
mkdir -p "$TOKENMAXXING_HOME/respawn"
mv "$EDGE_STAGED" "$TOKENMAXXING_HOME/respawn/$TOKENMAXXING_SESSION_ID"
`;

export type Supervised = { exitCode: number; stderr: string; launches: string[]; markersLeft: string[]; log: string };

export async function superviseWithMarker(markerLaunch: "same" | "earlier" | "none"): Promise<Supervised> {
  const box = sandbox("supervise");
  try {
    mkdirSync(join(box.root, "bin"));
    const bin = join(box.root, "bin", "claude");
    writeFileSync(bin, FAKE_CLAUDE);
    chmodSync(bin, 0o755);
    const launchesFile = join(box.root, "launches");
    const env = cleanEnv(box, {
      TOKENMAXXING_CLAUDE_BIN: bin,
      EDGE_LAUNCHES: launchesFile,
      EDGE_MARKED: join(box.root, "marked"),
      EDGE_STAGED: join(box.root, "staged-marker"),
      EDGE_MARKER_LAUNCH: markerLaunch,
    });
    const run = await runMain({ args: ["__supervise"], env, cwd: box.root });
    const respawnDir = join(box.tm, "respawn");
    return {
      exitCode: run.exitCode,
      stderr: run.stderr,
      launches: existsSync(launchesFile) ? readFileSync(launchesFile, "utf8").trim().split("\n") : [],
      markersLeft: existsSync(respawnDir) ? readdirSync(respawnDir) : [],
      log: readLog(box.tm),
    };
  } finally {
    dropSandbox(box);
  }
}
