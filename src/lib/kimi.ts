import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { resolveRealBin } from "./claudebin.ts";
import { withLock } from "./lock.ts";
import { http, safeErrorDetail } from "./http.ts";
import { errorMessage } from "./log.ts";
import { kimiConfigFor, kimiPaths, kimiPool, kimiStoreDirFor } from "./paths.ts";
import type { SampleReport } from "./provider.ts";
import type { Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { ErrnoSchema, JsonTextSchema, type Account, type Window } from "./types.ts";
import { c } from "../cli/render.ts";

const KIMI_BIN = { name: "kimi", key: "kimiBin" } as const;

const MANAGED_PROVIDER = "managed:kimi-code";

const GLOBAL_OAUTH_HOST = "https://auth.kimi.ai";

const KimiConfigSchema = z.looseObject({
  providers: z
    .looseObject({
      [MANAGED_PROVIDER]: z
        .looseObject({
          base_url: z.string().optional(),
          oauth: z.looseObject({ key: z.string().optional(), oauth_host: z.string().optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
});
type ManagedProvider = NonNullable<NonNullable<z.infer<typeof KimiConfigSchema>["providers"]>[typeof MANAGED_PROVIDER]>;

const KimiCredentialSchema = z.looseObject({ access_token: z.string().optional(), refresh_token: z.string().optional() });

const JwtPayloadSchema = z.looseObject({ user_id: z.string().min(1).optional(), sub: z.string().min(1).optional() });

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return null;
    throw e;
  }
}

function managedProvider(configText: string): ManagedProvider | null {
  return KimiConfigSchema.parse(Bun.TOML.parse(configText)).providers?.[MANAGED_PROVIDER] ?? null;
}

function credentialName(key: string | undefined): string | null {
  const ref = key ?? "oauth/kimi-code";
  const name = ref.startsWith("oauth/") ? ref.slice("oauth/".length) : ref;
  return name !== "" && !name.includes("/") && !name.startsWith(".") ? name : null;
}

function tokenUser(token: string): string | null {
  const payload = JwtPayloadSchema.safeParse(JsonTextSchema.safeParse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")).data).data;
  return payload?.user_id ?? payload?.sub ?? null;
}

const harvestLogins = new WeakMap<Harvest, { token: string; baseUrl: string | undefined }>();

function readAuth(configPath: string): AuthEntry[] {
  const configText = readOptional(configPath);
  if (configText == null) return [];
  const provider = managedProvider(configText);
  if (provider == null) return [];
  const name = credentialName(provider.oauth?.key);
  if (name == null) return [{ id: "", usable: false, harvest: null }];
  const home = dirname(configPath);
  const credentialRel = join("credentials", `${name}.json`);
  const credentialText = readOptional(join(home, credentialRel));
  const credential = credentialText == null ? null : KimiCredentialSchema.safeParse(JsonTextSchema.safeParse(credentialText).data).data;
  const token = credential?.access_token ?? "";
  if (credentialText == null || token === "") return [];
  const user = tokenUser(token);
  if (user == null) return [{ id: "", usable: false, harvest: null }];
  const id = new Bun.CryptoHasher("sha256").update(user).digest("hex");
  const markers = ["region", "device_id"].flatMap((rel) => {
    const text = readOptional(join(home, rel));
    return text == null ? [] : [{ rel, text }];
  });
  const harvest: Harvest = {
    id,
    email: null,
    tier: null,
    sample: null,
    park: async () => {
      const store = kimiStoreDirFor(id);
      rmSync(join(store, "credentials"), { recursive: true, force: true });
      mkdirSync(join(store, "credentials"), { recursive: true, mode: 0o700 });
      for (const file of [...markers, { rel: credentialRel, text: credentialText }, { rel: basename(configPath), text: configText }]) {
        writeFileAtomic(join(store, file.rel), file.text, 0o600);
      }
    },
  };
  harvestLogins.set(harvest, { token, baseUrl: provider.base_url });
  return [{ id, usable: (credential?.refresh_token ?? "") !== "", harvest }];
}

function loginArgs(): string[] {
  let provider: ManagedProvider | null;
  try {
    const text = readOptional(join(kimiPaths.home, "config.toml"));
    provider = text == null ? null : managedProvider(text);
  } catch {
    return ["login"];
  }
  return provider?.oauth?.oauth_host?.replace(/\/+$/, "") === GLOBAL_OAUTH_HOST ? ["login", "--region", "global"] : ["login"];
}

const MeSchema = z.looseObject({ email: z.string().nullish(), user_level_name: z.string().nullish() });

async function identify(harvest: Harvest): Promise<void> {
  const login = harvestLogins.get(harvest);
  if (login?.baseUrl == null) return;
  try {
    const res = await http.get(`${login.baseUrl.replace(/\/+$/, "")}/me`, { headers: { Authorization: `Bearer ${login.token}` } });
    const me = res.ok ? MeSchema.safeParse(JsonTextSchema.safeParse(await res.text()).data).data : undefined;
    const email = me?.email?.trim().toLowerCase();
    if (email) harvest.email = email;
    const tier = me?.user_level_name?.trim().toLowerCase();
    if (tier) harvest.tier = tier;
  } catch {
    return;
  }
}

const QuotaEntrySchema = z.looseObject({ usedRatio: z.number(), resetAt: z.string().optional() });

const ServerUsageSchema = z.looseObject({
  data: z.discriminatedUnion("kind", [
    z.looseObject({
      kind: z.literal("ok"),
      quota: z.looseObject({
        usages: z.looseObject({ limit5h: QuotaEntrySchema.optional(), limit7d: QuotaEntrySchema.optional(), monthTotal: QuotaEntrySchema.optional() }),
      }),
    }),
    z.looseObject({ kind: z.literal("error"), message: z.string(), status: z.number().optional() }),
  ]),
});

const ServerUserInfoSchema = z.looseObject({
  data: z.looseObject({ kind: z.literal("ok"), userInfo: z.looseObject({ email: z.string().optional(), userLevelName: z.string().optional() }) }),
});

const SESSION_S = 5 * 3600;
const WEEK_S = 7 * 86400;
const MONTH_S = 30 * 86400;
const SERVER_READY_MS = 20_000;
const SERVER_STOP_MS = 3_000;

function quotaWindow(name: string | null, entry: z.infer<typeof QuotaEntrySchema>, windowSeconds: number, now: number): Window {
  const resetsAt = entry.resetAt == null ? Number.NaN : Date.parse(entry.resetAt);
  return {
    name,
    usedPercentage: Math.min(100, Math.max(0, entry.usedRatio * 100)),
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    windowSeconds,
    sampledAt: now,
  };
}

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function serverReady(base: string, server: Bun.Subprocess): Promise<boolean> {
  const deadline = Date.now() + SERVER_READY_MS;
  while (Date.now() < deadline && server.exitCode == null) {
    try {
      if ((await http.get(`${base}/healthz`, { timeout: 1_000 })).ok) return true;
    } catch {}
    await Bun.sleep(100);
  }
  return false;
}

const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

const liveServers = new Set<Bun.Subprocess>();

function stopLiveServers(signal: (typeof STOP_SIGNALS)[number]): void {
  for (const s of STOP_SIGNALS) process.off(s, stopLiveServers);
  for (const server of liveServers) server.kill();
  process.kill(process.pid, signal);
}

function trackServer(server: Bun.Subprocess): void {
  if (liveServers.size === 0) for (const s of STOP_SIGNALS) process.on(s, stopLiveServers);
  liveServers.add(server);
}

async function stopServer(server: Bun.Subprocess): Promise<void> {
  server.kill();
  const stopped = await Promise.race([server.exited.then(() => true), Bun.sleep(SERVER_STOP_MS).then(() => false)]);
  if (!stopped) server.kill("SIGKILL");
  await server.exited;
  liveServers.delete(server);
  if (liveServers.size === 0) for (const s of STOP_SIGNALS) process.off(s, stopLiveServers);
}

type ServerRead = { usage: string; userInfo: string | null };

async function readThroughServer(store: string): Promise<ServerRead> {
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = Bun.spawn([resolveRealBin(KIMI_BIN), "web", "--no-open", "--port", String(port)], {
    cwd: store,
    env: { ...process.env, KIMI_CODE_HOME: store, TOKENMAXXING_PROBE: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  trackServer(server);
  try {
    if (!(await serverReady(base, server))) throw new Error(`the Kimi Code server did not start (exit ${server.exitCode ?? "none"})`);
    const headers = { Authorization: `Bearer ${readFileSync(join(store, "server.token"), "utf8").trim()}` };
    const query = `provider=${encodeURIComponent(MANAGED_PROVIDER)}`;
    const [usage, userInfo] = await Promise.all([
      http.get(`${base}/api/v1/oauth/usage?${query}`, { headers }),
      http.get(`${base}/api/v1/oauth/userinfo?${query}`, { headers }).catch(() => null),
    ]);
    if (!usage.ok) throw new Error(`HTTP ${usage.status}: ${safeErrorDetail({ text: await usage.text() })}`);
    return { usage: await usage.text(), userInfo: userInfo?.ok ? await userInfo.text() : null };
  } finally {
    await stopServer(server);
  }
}

const REAUTH_MESSAGE = /re-login required|run \/login/i;

async function readKimiUsage(account: Account, now: number): Promise<SampleReport> {
  let read: ServerRead | null;
  try {
    read = await withLock(kimiPool.lockFile, () => (readOptional(kimiConfigFor(account.id)) == null ? null : readThroughServer(kimiStoreDirFor(account.id))));
  } catch (e) {
    return { ok: false, reason: `Kimi Code usage read failed: ${errorMessage(e)}` };
  }
  if (read == null) return { ok: false, reason: "no Kimi Code login in this account's store - run `tokenmaxxing auth --kimi`" };
  const parsed = ServerUsageSchema.safeParse(JsonTextSchema.safeParse(read.usage).data);
  if (!parsed.success) return { ok: false, reason: "Kimi Code usage read failed: the server returned an unexpected body shape (withheld)" };
  const data = parsed.data.data;
  if (data.kind === "error") {
    if (data.status === 401 || data.status === 403 || REAUTH_MESSAGE.test(data.message)) {
      account.needsReauth = true;
      return { ok: false, reason: "Kimi Code rejected the stored login - run `tokenmaxxing auth --kimi`" };
    }
    return { ok: false, reason: `Kimi Code usage read failed: ${data.message.slice(0, 240)}` };
  }
  const { limit5h, limit7d, monthTotal } = data.quota.usages;
  const windows: Window[] = [];
  if (limit5h) windows.push(quotaWindow(null, limit5h, SESSION_S, now));
  if (limit7d) windows.push(quotaWindow(null, limit7d, WEEK_S, now));
  if (monthTotal) windows.push(quotaWindow(limit7d ? "month" : null, monthTotal, MONTH_S, now));
  if (windows.length === 0) return { ok: false, reason: "Kimi Code reports no quota window for this account" };
  account.windows = windows;
  account.lastUsageAt = now;
  const info = read.userInfo == null ? undefined : ServerUserInfoSchema.safeParse(JsonTextSchema.safeParse(read.userInfo).data).data?.data.userInfo;
  const email = info?.email?.trim().toLowerCase();
  if (email) account.email = email;
  const tier = info?.userLevelName?.trim().toLowerCase();
  if (tier) account.tier = tier;
  return { ok: true, source: "probe" };
}

async function samplePool(accounts: Account[], now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(accounts.map(async (account) => reports.set(account.id, await readKimiUsage(account, now))));
  return reports;
}

export const kimi = statusOnlyProvider({
  name: "kimi",
  flag: " --kimi",
  pool: kimiPool,
  binName: KIMI_BIN.name,
  binKey: KIMI_BIN.key,
  storeDirFor: kimiStoreDirFor,
  authJsonFor: kimiConfigFor,
  homeEnv: "KIMI_CODE_HOME",
  loginArgs,
  onboardAuthRel: "config.toml",
  readAuth,
  liveId: () => null,
  presence: () => new Map(),
  versionOk: (out) => Number(/^(\d+)\.\d+\.\d+/.exec(out.trim())?.[1] ?? 0) >= 2,
  importIntro: "Opening an isolated Kimi Code login for your first pooled account - the login you already have stays as it is.",
  live: null,
  install: () => {
    console.log(c.dim("kimi pool is status-only: no supervisor or hooks installed. Use `tokenmaxxing status` to view pooled Kimi Code accounts."));
  },
  loginStep: () => `Enter the code that ${c.bold("kimi login")} prints in the browser page it opens.`,
  samplePool,
  identify,
});
