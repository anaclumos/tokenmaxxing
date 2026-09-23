import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { sortBy } from "es-toolkit";
import { z } from "zod";
import { writeFileAtomic } from "../lib/atomic.ts";
import { claude } from "../lib/claude.ts";
import { codex, observeCodex } from "../lib/codex.ts";
import { CODEX_USAGE_URL } from "../lib/codexusage.ts";
import { errorMessage, log } from "../lib/log.ts";
import { hubDeactivationHint } from "../lib/install.ts";
import { paths } from "../lib/paths.ts";
import { isExhausted, thresholdBars } from "../lib/picker.ts";
import type { Provider } from "../lib/provider.ts";
import { foldTee } from "../lib/sample.ts";
import { loadAccounts, loadConfig } from "../lib/state.ts";
import { OAUTH_USAGE_URL } from "../lib/usage.ts";
import type { Account, Config } from "../lib/types.ts";
import { c, emitError } from "./render.ts";
import { usageReport, type UsageReport, type WindowReport } from "./status.ts";

const MANAGEMENT_PREFIX = "/v0/management/";
const STALE_AFTER_MS = 2 * 60 * 60_000;

type HubPool = {
  provider: Provider;
  usageUrl: string;
  fold: (account: Account) => void;
  read: (account: Account, cfg: Config, now: number) => Promise<Account>;
  body: (usage: UsageReport, account: Account) => unknown;
};

function iso(epochMs: number | null): string | null {
  return epochMs == null ? null : new Date(epochMs).toISOString();
}

function claudeBody(usage: UsageReport): unknown {
  const win = (w: WindowReport | null) => (w ? { utilization: w.usedPercentage, resets_at: iso(w.resetsAt) } : null);
  return {
    five_hour: win(usage.fiveHour),
    seven_day: win(usage.week),
    limits: usage.limits.map((w) => ({ kind: "weekly_scoped", percent: w.usedPercentage, resets_at: iso(w.resetsAt), scope: { model: { display_name: w.name } } })),
  };
}

function codexBody(usage: UsageReport, account: Account): unknown {
  const win = (w: WindowReport | undefined) =>
    w
      ? {
          used_percent: w.usedPercentage,
          reset_at: w.resetsAt == null ? null : Math.round(w.resetsAt / 1000),
          ...(w.windowSeconds == null ? {} : { limit_window_seconds: w.windowSeconds }),
        }
      : null;
  const pair = (windows: WindowReport[]) => {
    const ordered = sortBy(windows, [(w) => w.windowSeconds ?? Number.POSITIVE_INFINITY]);
    return { primary_window: win(ordered[0]), secondary_window: win(ordered[1]) };
  };
  const named = new Map<string, WindowReport[]>();
  for (const w of usage.limits) named.set(w.name, [...(named.get(w.name) ?? []), w]);
  return {
    ...(account.tier ? { plan_type: account.tier } : {}),
    rate_limit: pair([usage.fiveHour, usage.week].filter((w) => w != null)),
    ...(named.size === 0 ? {} : { additional_rate_limits: [...named].map(([limit_name, windows]) => ({ limit_name, rate_limit: pair(windows) })) }),
  };
}

const POOLS: HubPool[] = [
  {
    provider: claude,
    usageUrl: OAUTH_USAGE_URL,
    fold: foldTee,
    read: async (account) => account,
    body: claudeBody,
  },
  {
    provider: codex,
    usageUrl: CODEX_USAGE_URL,
    fold: () => {},
    read: async (account, cfg, now) => {
      await observeCodex(account, cfg, now, { probe: true, refresh: false });
      return loadAccounts(codex.pool).accounts.find((a) => a.id === account.id) ?? account;
    },
    body: codexBody,
  },
];

function authIndex(pool: HubPool, account: Account): string {
  return new Bun.CryptoHasher("sha256").update(`${pool.provider.name}:${account.id}`).digest("hex").slice(0, 16);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function authFiles(cfg: Config, now: number): unknown {
  const files = POOLS.flatMap((pool) => {
    const ctx = { now, thresholds: thresholdBars(cfg), currentId: null, families: pool.provider.gatedFamilies(cfg), seats: null };
    return loadAccounts(pool.provider.pool).accounts.map((a) => {
      pool.fold(a);
      return {
        id: a.id,
        auth_index: authIndex(pool, a),
        name: a.label,
        type: pool.provider.name,
        provider: pool.provider.name,
        label: a.label,
        ...(a.email ? { email: a.email } : {}),
        status: a.needsReauth === true ? "error" : "active",
        status_message: a.needsReauth === true ? `needs reauth - run \`tokenmaxxing auth${pool.provider.flag} ${a.label}\`` : "",
        disabled: false,
        unavailable: isExhausted(a, ctx),
      };
    });
  });
  return { observed_at: new Date(now).toISOString(), files };
}

const ApiCallSchema = z.looseObject({
  auth_index: z.string().optional(),
  authIndex: z.string().optional(),
  AuthIndex: z.string().optional(),
  method: z.string().optional(),
  url: z.string().optional(),
});

async function apiCall(req: Request): Promise<Response> {
  const parsed = ApiCallSchema.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return json({ error: "invalid body" }, 400);
  const call = parsed.data;
  const method = (call.method ?? "").trim().toUpperCase();
  if (method === "") return json({ error: "missing method" }, 400);
  if (!call.url) return json({ error: "missing url" }, 400);
  const target = URL.parse(call.url);
  if (!target) return json({ error: "invalid url" }, 400);
  const pool = POOLS.find((p) => p.usageUrl === `${target.origin}${target.pathname}`);
  if (method !== "GET" || !pool) {
    return json({ error: `unsupported request: this hub serves ${POOLS.map((p) => `GET ${p.usageUrl}`).join(" and ")} only` }, 400);
  }
  const index = call.auth_index ?? call.authIndex ?? call.AuthIndex ?? "";
  const account = loadAccounts(pool.provider.pool).accounts.find((a) => authIndex(pool, a) === index);
  if (!account) return json({ error: "auth credential not found for auth_index" }, 400);
  const now = Date.now();
  const current = await pool.read(account, loadConfig(), now);
  pool.fold(current);
  const usage = usageReport({ ...current, windows: current.windows.filter((w) => now - w.sampledAt <= STALE_AFTER_MS) }, now);
  if (!usage || (!usage.fiveHour && !usage.week)) return json({ error: `no usage figure newer than ${STALE_AFTER_MS / 3_600_000}h for this account` }, 502);
  return json({ status_code: 200, header: { "Content-Type": ["application/json"] }, body: JSON.stringify(pool.body(usage, current)) });
}

function presentedKey(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== "") {
    const at = auth.indexOf(" ");
    return at > 0 && auth.slice(0, at).toLowerCase() === "bearer" ? auth.slice(at + 1) : auth;
  }
  return req.headers.get("x-management-key") ?? "";
}

function keyMatches(presented: string, key: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function unauthorized(req: Request, key: string): Response | null {
  const presented = presentedKey(req);
  if (presented === "") return json({ error: "missing management key" }, 401);
  if (!keyMatches(presented, key)) return json({ error: "invalid management key" }, 401);
  return null;
}

function guarded(key: string, handler: (req: Request) => Response | Promise<Response>): (req: Request) => Response | Promise<Response> {
  return (req) => unauthorized(req, key) ?? handler(req);
}

function notFound(req: Request, key: string): Response {
  const url = new URL(req.url);
  return (url.pathname.startsWith(MANAGEMENT_PREFIX) ? unauthorized(req, key) : null) ?? json({ error: "not found" }, 404);
}

function managementKey(): string {
  if (existsSync(paths.hubKeyFile)) {
    const mode = statSync(paths.hubKeyFile).mode & 0o777;
    if (mode & 0o077) throw new Error(`${paths.hubKeyFile} is mode ${mode.toString(8)}, readable by other local users - chmod 600 it`);
    const key = readFileSync(paths.hubKeyFile, "utf8").trim();
    if (key === "") throw new Error(`${paths.hubKeyFile} is empty - write a management key into it, or delete it and serve mints one`);
    return key;
  }
  const key = randomBytes(32).toString("hex");
  writeFileAtomic(paths.hubKeyFile, `${key}\n`);
  log("hub.key_minted", { file: paths.hubKeyFile });
  return key;
}

export async function cmdServe(args: string[]): Promise<number> {
  if (args.length > 0) {
    emitError({ message: `unknown serve option: ${args[0]} (serve takes no options; set hub.port in ${paths.configJson})` });
    return 2;
  }
  const cfg = loadConfig();
  const key = managementKey();
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "localhost",
      port: cfg.hub.port,
      routes: {
        [`${MANAGEMENT_PREFIX}auth-files`]: { GET: guarded(key, () => json(authFiles(loadConfig(), Date.now()))) },
        [`${MANAGEMENT_PREFIX}api-call`]: { POST: guarded(key, apiCall) },
      },
      fetch: (req) => notFound(req, key),
      error: (e) => {
        log("hub.error", { err: errorMessage(e) });
        return json({ error: "internal error" }, 500);
      },
    });
  } catch (e) {
    emitError({ message: `cannot bind localhost:${cfg.hub.port}: ${errorMessage(e)} (another \`tokenmaxxing serve\` or the usage hub service may already hold the port - stop it first: ${hubDeactivationHint()})` });
    return 1;
  }
  console.log(`${c.green("✓")} serving the CLIProxyAPI-compatible usage API at http://localhost:${server.port}/v0/management`);
  console.log(c.dim(`management key: the contents of ${paths.hubKeyFile}`));
  log("hub.started", { port: server.port });
  return new Promise<number>((resolve) => {
    const stop = (signal: string) => {
      server.stop(true);
      log("hub.stopped", { signal });
      resolve(0);
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
}
