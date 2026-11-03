import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MAIN = join(ROOT, "src", "main.ts");
export const DAY_MS = 24 * 60 * 60 * 1000;

type CapturedEvent = {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp?: string;
  uuid?: string;
};

type CapturedBatch = {
  api_key?: string;
  batch: CapturedEvent[];
};

export type StubHost = {
  url: string;
  requests: CapturedBatch[];
  stop: () => void;
};

export function startStubHost(): StubHost {
  const requests: CapturedBatch[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || !/^\/batch\/?$/.test(path)) {
        return Response.json({}, { status: 200 });
      }
      const raw = new Uint8Array(await request.arrayBuffer());
      const encoding = request.headers.get("content-encoding") ?? "";
      const bytes = encoding.includes("gzip") ? Bun.gunzipSync(raw) : raw;
      const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<CapturedBatch>;
      requests.push({ api_key: value.api_key, batch: Array.isArray(value.batch) ? value.batch : [] });
      return Response.json({ status: 1 }, { status: 200 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

export type Homes = {
  home: string;
  state: string;
};

export function freshHomes(): Homes {
  const home = mkdtempSync(join(tmpdir(), "tokenmaxxing-edge-home-"));
  const state = mkdtempSync(join(tmpdir(), "tokenmaxxing-edge-state-"));
  mkdirSync(join(home, ".config"), { recursive: true });
  return { home, state };
}

export function childEnv(
  homes: Homes,
  hostUrl: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "CI" || key === "DO_NOT_TRACK") continue;
    if (key === "HOME" || key.startsWith("XDG_") || key.startsWith("TOKENMAXXING_")) continue;
    env[key] = value;
  }
  env.HOME = homes.home;
  env.XDG_CONFIG_HOME = join(homes.home, ".config");
  env.XDG_STATE_HOME = join(homes.home, ".local", "state");
  env.XDG_DATA_HOME = join(homes.home, ".local", "share");
  env.XDG_CACHE_HOME = join(homes.home, ".cache");
  env.TOKENMAXXING_HOME = homes.state;
  env.TOKENMAXXING_POSTHOG_HOST = hostUrl;
  env.TOKENMAXXING_SKIP_TIMER = "1";
  env.TOKENMAXXING_SKIP_HUB = "1";
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function run(args: string[], env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    env,
    cwd: ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

function spoolText(homes: Homes): string {
  const path = join(homes.state, "telemetry.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function spoolEvents(homes: Homes): Array<Record<string, unknown>> {
  return spoolText(homes)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function spoolIsEmpty(homes: Homes): boolean {
  return spoolText(homes).trim().length === 0;
}

type TelemetryState = {
  installId: string;
  noticeAt: number | null;
  attemptedAt: number | null;
};

function statePath(homes: Homes): string {
  return join(homes.state, "telemetry.json");
}

export function writeState(homes: Homes, patch: Partial<TelemetryState>): TelemetryState {
  const path = statePath(homes);
  const current = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as TelemetryState)
    : { installId: crypto.randomUUID(), noticeAt: null, attemptedAt: null };
  const next: TelemetryState = { ...current, ...patch };
  mkdirSync(homes.state, { recursive: true });
  writeFileSync(path, JSON.stringify(next));
  return next;
}

export function configPath(homes: Homes): string {
  return join(homes.state, "config.json");
}

export function readConfig(homes: Homes): Record<string, unknown> | null {
  const path = configPath(homes);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
