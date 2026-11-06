import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { loadApiKeys } from "./apikeys.ts";
import { writeFileAtomic } from "./atomic.ts";
import { withLock } from "./lock.ts";
import { errorMessage, log } from "./log.ts";
import { claudePool, codexPool, cursorPool, env, grokPool, kimiPool, musePool, optionalEnv, paths, type PoolPaths } from "./paths.ts";
import { loadAccounts, loadConfig, setConfigField } from "./state.ts";
import { JsonTextSchema } from "./types.ts";
import { detectGlobalRoot } from "./update.ts";

const TOKEN = "phc_nKHAgF4e9iPDo24swbRY45mHXeEgRuoBz9k3HVSEfWCf";
const HOST = env("TOKENMAXXING_POSTHOG_HOST", "https://us.i.posthog.com");
const DAY_MS = 24 * 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 10_000;
const SPOOL_MAX_BYTES = 2_000_000;
const OFF_WORDS = new Set(["0", "false", "off", "no"]);

export const TELEMETRY_DOCS = "https://github.com/anaclumos/tokenmaxxing#telemetry";

const stateJson = join(paths.home, "telemetry.json");
const spoolFile = join(paths.home, "telemetry.jsonl");
const lockFile = join(paths.home, "telemetry.lock");

const PoolSchema = z.enum(["claude", "codex", "grok", "muse", "cursor", "kimi"]);
const BucketSchema = z.enum(["0", "1", "2-5", "6-20", "21+"]);
const CountSchema = z.number().int().nonnegative();
const VersionSchema = z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/);

export const TRACKED_COMMANDS = ["status", "config", "init", "add", "auth", "emails", "doctor", "rm", "rename", "key", "seat", "serve", "telemetry", "unknown"] as const;
export const TRACKED_FLAGS = ["--json", "--cached", "--yes", "--pi", "--all", "--emails", "--store"] as const;

const EventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("command"),
    command: z.enum(TRACKED_COMMANDS),
    pool: PoolSchema,
    flags: z.array(z.enum(TRACKED_FLAGS)),
    exit_code: z.number().int(),
    duration_ms: CountSchema,
  }),
  z.object({
    event: z.literal("session_end"),
    tool: z.enum(["claude", "codex", "pi", "muse"]),
    interactive: z.boolean(),
    moves: CountSchema,
    outcome: z.enum(["exit", "depleted", "fatal"]),
    exit_code: z.number().int(),
    duration_ms: CountSchema,
  }),
  z.object({ event: z.literal("compaction"), result: z.enum(["ok", "failed", "skipped"]) }),
  z.object({ event: z.literal("account_added"), pool: PoolSchema, pool_size: BucketSchema }),
  z.object({ event: z.literal("account_imported"), pool: PoolSchema, pool_size: BucketSchema }),
  z.object({ event: z.literal("account_removed"), pool: PoolSchema, pool_size: BucketSchema }),
  z.object({ event: z.literal("account_reauthenticated"), pool: PoolSchema }),
  z.object({ event: z.literal("account_renamed"), pool: PoolSchema }),
  z.object({ event: z.literal("pi_login_added"), pool: z.enum(["claude", "codex"]) }),
  z.object({ event: z.literal("update"), from: VersionSchema, to: VersionSchema }),
  z.object({ event: z.literal("uninstall") }),
  z.object({
    event: z.literal("install_daily"),
    install: z.enum(["bun-global", "other"]),
    bun: VersionSchema,
    accounts_claude: BucketSchema,
    accounts_codex: BucketSchema,
    accounts_grok: BucketSchema,
    accounts_muse: BucketSchema,
    accounts_cursor: BucketSchema,
    accounts_kimi: BucketSchema,
    api_keys: BucketSchema,
  }),
]);

const LineSchema = z
  .object({ uuid: z.uuid(), at: CountSchema, version: VersionSchema, os: z.enum(["darwin", "linux"]), arch: z.string().regex(/^[a-z0-9]{1,16}$/) })
  .and(EventSchema);
type Line = z.output<typeof LineSchema>;

type TelemetryEvent = Exclude<z.input<typeof EventSchema>, { event: "install_daily" }>;

const StateSchema = z.object({ installId: z.uuid(), noticeAt: CountSchema.nullable(), attemptedAt: CountSchema.nullable() });
type State = z.output<typeof StateSchema>;

export type Telemetry = "on" | "off" | "env" | "ci";

const BUCKETS = [[0, "0"], [1, "1"], [5, "2-5"], [20, "6-20"]] as const;

export function bucket(n: number): z.output<typeof BucketSchema> {
  return BUCKETS.find(([max]) => n <= max)?.[1] ?? "21+";
}

function flagged(name: string): boolean {
  const value = optionalEnv(name);
  return value != null && !OFF_WORDS.has(value.toLowerCase());
}

function envOptedOut(): boolean {
  const own = optionalEnv("TOKENMAXXING_TELEMETRY");
  return flagged("DO_NOT_TRACK") || (own != null && OFF_WORDS.has(own.toLowerCase()));
}

export function telemetryState(): Telemetry {
  if (flagged("CI")) return "ci";
  if (!loadConfig().telemetry) return "off";
  if (!envOptedOut()) return "on";
  setConfigField("telemetry", false);
  rmSync(spoolFile, { force: true });
  log("telemetry.opted_out", { by: "env" });
  return "env";
}

export function setTelemetry(on: boolean): Promise<void> {
  return withLock(lockFile, () => {
    setConfigField("telemetry", on);
    if (!on) rmSync(spoolFile, { force: true });
  });
}

function loadState(): State {
  const stored = existsSync(stateJson) ? StateSchema.safeParse(JsonTextSchema.safeParse(readFileSync(stateJson, "utf8")).data).data : undefined;
  return stored ?? { installId: crypto.randomUUID(), noticeAt: null, attemptedAt: null };
}

function saveState(state: State): void {
  writeFileAtomic(stateJson, JSON.stringify(state) + "\n");
}

function line(event: z.input<typeof EventSchema>): Line {
  return LineSchema.parse({ ...event, uuid: crypto.randomUUID(), at: Date.now(), version: pkg.version, os: process.platform, arch: process.arch });
}

export function record(event: TelemetryEvent): void {
  try {
    if (telemetryState() !== "on" || (existsSync(spoolFile) && statSync(spoolFile).size > SPOOL_MAX_BYTES)) return;
    mkdirSync(paths.home, { recursive: true });
    appendFileSync(spoolFile, JSON.stringify(line(event)) + "\n", { mode: 0o600 });
  } catch (e) {
    log("telemetry.record_failed", { err: errorMessage(e) });
  }
}

type SessionEnd = Extract<TelemetryEvent, { event: "session_end" }>;

export function endSession(session: Pick<SessionEnd, "tool" | "moves" | "outcome"> & { startedAt: number; code: number }): number {
  record({
    event: "session_end",
    tool: session.tool,
    interactive: process.stdin.isTTY === true,
    moves: session.moves,
    outcome: session.outcome,
    exit_code: session.code,
    duration_ms: Date.now() - session.startedAt,
  });
  return session.code;
}

export async function showTelemetryNotice(): Promise<void> {
  try {
    if (!process.stderr.isTTY || telemetryState() !== "on") return;
    await withLock(lockFile, () => {
      const state = loadState();
      if (state.noticeAt != null) return;
      process.stderr.write(
        `tokenmaxxing sends anonymous usage statistics once a day: the commands you run, session and account counts, and versions. It never sends account names, emails, paths, or prompts. Turn it off with \`tokenmaxxing telemetry off\` or DO_NOT_TRACK=1. Details: ${TELEMETRY_DOCS}\n\n`,
      );
      saveState({ ...state, noticeAt: Date.now() });
    });
  } catch (e) {
    log("telemetry.notice_failed", { err: errorMessage(e) });
  }
}

function readSpool(): Buffer {
  return existsSync(spoolFile) ? readFileSync(spoolFile) : Buffer.alloc(0);
}

function spooled(batch: Buffer): Line[] {
  return batch
    .toString("utf8")
    .split("\n")
    .flatMap((text) => LineSchema.safeParse(JsonTextSchema.safeParse(text).data).data ?? []);
}

function dailyLine(): Line {
  const size = (pool: PoolPaths) => bucket(loadAccounts(pool).accounts.length);
  return line({
    event: "install_daily",
    install: detectGlobalRoot() == null ? "other" : "bun-global",
    bun: Bun.version,
    accounts_claude: size(claudePool),
    accounts_codex: size(codexPool),
    accounts_grok: size(grokPool),
    accounts_muse: size(musePool),
    accounts_cursor: size(cursorPool),
    accounts_kimi: size(kimiPool),
    api_keys: bucket(loadApiKeys().keys.length),
  });
}

async function send(installId: string, lines: Line[]): Promise<void> {
  const { PostHog } = await import("posthog-node");
  const room = lines.length + 1;
  const client = new PostHog(TOKEN, {
    host: HOST,
    flushAt: room,
    maxQueueSize: room,
    flushInterval: 0,
    fetchRetryCount: 0,
    requestTimeout: SEND_TIMEOUT_MS,
    disableGeoip: true,
    isServer: false,
  });
  for (const { uuid, at, event, ...properties } of lines) {
    client.capture({ distinctId: installId, event, uuid, timestamp: new Date(at), properties });
  }
  await client.flush();
}

async function flush(due: (since: number) => boolean): Promise<void> {
  try {
    await withLock(lockFile, async () => {
      const telemetry = telemetryState();
      if (telemetry === "ci") return;
      if (telemetry !== "on") {
        rmSync(spoolFile, { force: true });
        return;
      }
      const state = loadState();
      const since = state.attemptedAt ?? state.noticeAt;
      if (since == null || !due(since)) return;
      saveState({ ...state, attemptedAt: Date.now() });
      const batch = readSpool();
      await send(state.installId, [...spooled(batch), dailyLine()]);
      writeFileAtomic(spoolFile, readSpool().subarray(batch.length));
    });
  } catch (e) {
    log("telemetry.flush_failed", { err: errorMessage(e) });
  }
}

export function flushTelemetry(now: number): Promise<void> {
  return flush((since) => now - since >= DAY_MS);
}

export function flushTelemetryNow(): Promise<void> {
  return flush(() => true);
}
