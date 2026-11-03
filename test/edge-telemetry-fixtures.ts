import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const MAIN = join(ROOT, "src", "main.ts");
export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

export type CapturedEvent = {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp?: string;
  uuid?: string;
};

export type CapturedBatch = {
  api_key?: string;
  batch: CapturedEvent[];
};

export type StubBehavior = "accept" | "refuse" | "hang";

export type StubHost = {
  url: string;
  requests: CapturedBatch[];
  setBehavior: (next: StubBehavior) => void;
  stop: () => void;
};

export function startStubHost(behavior: StubBehavior = "accept"): StubHost {
  const requests: CapturedBatch[] = [];
  let mode: StubBehavior = behavior;
  const hung: Array<(response: Response) => void> = [];
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
      let parsed: CapturedBatch = { batch: [] };
      try {
        const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<CapturedBatch>;
        parsed = { api_key: value.api_key, batch: Array.isArray(value.batch) ? value.batch : [] };
      } catch {
        parsed = { batch: [] };
      }
      requests.push(parsed);
      if (mode === "hang") {
        return new Promise<Response>((resolve) => {
          hung.push(resolve);
        });
      }
      if (mode === "refuse") {
        return Response.json({ error: "refused" }, { status: 500 });
      }
      return Response.json({ status: 1 }, { status: 200 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    setBehavior: (next) => {
      mode = next;
    },
    stop: () => {
      for (const resolve of hung.splice(0)) resolve(new Response(null, { status: 503 }));
      server.stop(true);
    },
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
  durationMs: number;
};

export async function run(
  args: string[],
  env: Record<string, string>,
  options: { timeoutMs?: number } = {},
): Promise<RunResult> {
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    env,
    cwd: ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer =
    options.timeoutMs === undefined ? undefined : setTimeout(() => proc.kill("SIGKILL"), options.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return { exitCode, stdout, stderr, durationMs: Date.now() - started };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function runOnTerminal(args: string[], env: Record<string, string>): Promise<RunResult> {
  const started = Date.now();
  const line = [process.execPath, MAIN, ...args].map(shellQuote).join(" ");
  const proc = Bun.spawn(["script", "-q", "-e", "-c", line, "/dev/null"], {
    env,
    cwd: ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr, durationMs: Date.now() - started };
}

export function spoolPath(homes: Homes): string {
  return join(homes.state, "telemetry.jsonl");
}

export function spoolText(homes: Homes): string {
  const path = spoolPath(homes);
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

export type TelemetryState = {
  installId: string;
  noticeAt: number | null;
  attemptedAt: number | null;
};

export function statePath(homes: Homes): string {
  return join(homes.state, "telemetry.json");
}

export function readState(homes: Homes): TelemetryState | null {
  const path = statePath(homes);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as TelemetryState;
}

export function writeState(homes: Homes, patch: Partial<TelemetryState>): TelemetryState {
  const current = readState(homes) ?? { installId: crypto.randomUUID(), noticeAt: null, attemptedAt: null };
  const next: TelemetryState = { ...current, ...patch };
  mkdirSync(homes.state, { recursive: true });
  writeFileSync(statePath(homes), JSON.stringify(next));
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

export function sentEvents(host: StubHost): CapturedEvent[] {
  return host.requests.flatMap((request) => request.batch);
}

export function leafValues(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) leafValues(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) leafValues(item, out);
  } else {
    out.push(value);
  }
  return out;
}

export function packageVersion(): string {
  const raw = readFileSync(join(ROOT, "package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}
