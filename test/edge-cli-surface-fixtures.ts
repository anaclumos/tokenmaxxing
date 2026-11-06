import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Account } from "../src/lib/types.ts";
import { account } from "./fixtures.ts";
import type { Homes, run } from "./edge-telemetry-fixtures.ts";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");

type Pool = "claude" | "codex" | "grok" | "muse" | "cursor" | "kimi";

const POOL_FILES: Record<Pool, string> = {
  claude: "accounts.json",
  codex: "codex-accounts.json",
  grok: "grok-accounts.json",
  muse: "muse-accounts.json",
  cursor: "cursor-accounts.json",
  kimi: "kimi-accounts.json",
};

const STORE_DIRS: Record<Pool, string> = {
  claude: "stores",
  codex: "codex-stores",
  grok: "grok-stores",
  muse: "muse-stores",
  cursor: "cursor-stores",
  kimi: "kimi-stores",
};

const JsonObjectSchema = z.record(z.string(), z.unknown());
const ApiKeysFileSchema = z.object({ keys: z.array(JsonObjectSchema) });
const PoolReportSchema = z.object({ accounts: z.array(z.looseObject({ id: z.string(), active: z.boolean() })) });
const KeyRecordSchema = z.looseObject({ label: z.string(), openrouter: z.object({ remainingUsd: z.number().nullable() }).optional() });

export async function runWithStdin(args: string[], env: Record<string, string>, stdin: string): ReturnType<typeof run> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    env,
    cwd: ROOT,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

export function labeled(id: string, label: string, tier: string): Account {
  return { ...account(id, tier, []), label };
}

export function writePool(homes: Homes, pool: Pool, accounts: Account[]): void {
  writeFileSync(join(homes.state, POOL_FILES[pool]), JSON.stringify({ version: 2, accounts }));
}

export function storeDir(homes: Homes, pool: Pool, id: string): string {
  return join(homes.state, STORE_DIRS[pool], id.slice(0, 8));
}

export function writeGrokStore(homes: Homes, id: string, refreshToken: string): void {
  const path = join(storeDir(homes, "grok", id), "auth.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ [id]: { user_id: id, key: `key-${id}`, refresh_token: refreshToken } }), { mode: 0o600 });
}

export function grokStoreRefreshToken(homes: Homes, id: string): string | null {
  const path = join(storeDir(homes, "grok", id), "auth.json");
  if (!existsSync(path)) return null;
  const entry = z.record(z.string(), z.looseObject({ refresh_token: z.string().optional() })).parse(JSON.parse(readFileSync(path, "utf8")))[id];
  return entry?.refresh_token ?? null;
}

export function installFakeGrok(homes: Homes): { logins: () => string[] } {
  const bin = join(homes.home, "fake-grok", "grok");
  const log = join(homes.home, "fake-grok", "logins.log");
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$FAKE_GROK_ID" >> "$FAKE_GROK_LOG"',
      'printf \'{"%s":{"user_id":"%s","key":"fresh-key","refresh_token":"fresh-refresh"}}\' "$FAKE_GROK_ID" "$FAKE_GROK_ID" > "$GROK_HOME/auth.json"',
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  const configPath = join(homes.state, "config.json");
  const config = JsonObjectSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  writeFileSync(configPath, JSON.stringify({ ...config, grokBin: bin }));
  return {
    logins: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : []),
  };
}

export function fakeGrokEnv(base: Record<string, string>, homes: Homes, loginAs: string): Record<string, string> {
  return { ...base, FAKE_GROK_ID: loginAs, FAKE_GROK_LOG: join(homes.home, "fake-grok", "logins.log") };
}

export function reauthTargets(stdout: string): string[] {
  return [...stdout.matchAll(/^Reauthenticating (\S+) - sign in as/gm)].map((m) => m[1] ?? "");
}

export function writeApiKeysFile(homes: Homes, doc: unknown): void {
  writeFileSync(join(homes.state, "api-keys.json"), JSON.stringify(doc));
}

export function apiKeyRecords(homes: Homes): Record<string, unknown>[] {
  return ApiKeysFileSchema.parse(JSON.parse(readFileSync(join(homes.state, "api-keys.json"), "utf8"))).keys;
}

export function apiKeyRecord(homes: Homes, label: string): z.infer<typeof KeyRecordSchema> | null {
  return apiKeyRecords(homes).map((k) => KeyRecordSchema.parse(k)).find((k) => k.label === label) ?? null;
}

export function telemetrySetting(homes: Homes): unknown {
  return JsonObjectSchema.parse(JSON.parse(readFileSync(join(homes.state, "config.json"), "utf8"))).telemetry;
}

export function activeIds(doc: Record<string, unknown> | null, pool: Pool): string[] {
  const report = PoolReportSchema.safeParse(doc?.[pool]);
  return report.success ? report.data.accounts.filter((a) => a.active).map((a) => a.id) : ["<no report>"];
}

export function poolIds(doc: Record<string, unknown> | null, pool: Pool): string[] {
  const report = PoolReportSchema.safeParse(doc?.[pool]);
  return report.success ? report.data.accounts.map((a) => a.id) : ["<no report>"];
}

export function poolHeaders(stdout: string): string[] {
  return stdout.split("\n").filter((line) => /^(codex|grok|muse|cursor|kimi) {2}\(/.test(line));
}

export function serveOpenRouter(remaining: number[]): { base: string; bearers: string[]; stop: () => void } {
  const bearers: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname !== "/openrouter/api/v1/key") return Response.json({ error: "not stubbed" }, { status: 404 });
      const left = remaining[Math.min(bearers.length, remaining.length - 1)] ?? null;
      bearers.push(req.headers.get("authorization") ?? "");
      return Response.json({ data: { label: "sk-or-v1-a1b...9f0", limit: 20, limit_remaining: left, is_free_tier: false, rate_limit: { requests: -1, interval: "10s" } } });
    },
  });
  return { base: `http://127.0.0.1:${server.port}`, bearers, stop: () => void server.stop(true) };
}
