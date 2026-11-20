import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { resolveRealBin } from "./claudebin.ts";
import { AgyRefreshFailedError, refreshAgyAccessToken } from "./agyoauth.ts";
import { http, safeErrorDetail } from "./http.ts";
import { readItemSync } from "./keychain.ts";
import { errorMessage } from "./log.ts";
import { loadConfig } from "./state.ts";
import { agyAuthJsonFor, agyPaths, agyPool, agyStoreDirFor, env } from "./paths.ts";
import type { SampleReport } from "./provider.ts";
import type { Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { ErrnoSchema, JsonTextSchema, type Account, type Window } from "./types.ts";
import { c } from "../cli/render.ts";

const KEYRING = { service: "gemini", account: "antigravity" } as const;
const SESSION_S = 5 * 3600;
const WEEK_S = 7 * 86400;
const AUTH_METHOD_GCP = "gcp";
const DEFAULT_PROJECT = "default-cli-project";

const TokenFileSchema = z.looseObject({
  token: z.looseObject({
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
    expiry: z.string().optional(),
  }),
  auth_method: z.string().optional(),
  id_token: z.string().optional(),
  id_token_email: z.string().optional(),
  project_id: z.string().optional(),
});
type TokenFile = z.infer<typeof TokenFileSchema>;

const JwtPayloadSchema = z.looseObject({ sub: z.string().min(1), email: z.string().optional() });

function isMissing(e: unknown): boolean {
  return ErrnoSchema.safeParse(e).data?.code === "ENOENT";
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

function parseTokenFile(text: string): TokenFile | null {
  return TokenFileSchema.safeParse(JsonTextSchema.safeParse(text).data).data ?? null;
}

function tokenExpired(file: TokenFile, now: number): boolean {
  const expiry = file.token.expiry?.trim() ?? "";
  if (expiry === "") return false;
  const parsed = Date.parse(expiry);
  return Number.isFinite(parsed) && parsed <= now + 30_000;
}

function idTokenClaims(file: TokenFile): { sub: string | null; email: string | null } {
  const payload = file.id_token?.split(".")[1] ?? "";
  const claims = JwtPayloadSchema.safeParse(JsonTextSchema.safeParse(Buffer.from(payload, "base64url").toString("utf8")).data).data;
  const email = file.id_token_email?.trim().toLowerCase() || claims?.email?.trim().toLowerCase() || null;
  return { sub: claims?.sub ?? null, email };
}

function accountOwner(file: TokenFile): string | null {
  const { sub, email } = idTokenClaims(file);
  const owner = sub ?? email;
  if (owner == null) return null;
  const project = file.project_id?.trim() ?? "";
  const scoped = file.auth_method?.toLowerCase() === AUTH_METHOD_GCP && project !== "" ? `${owner}:gcp:${project}` : owner;
  return new Bun.CryptoHasher("sha256").update(scoped).digest("hex");
}

const harvestTokens = new WeakMap<Harvest, TokenFile>();

function tokenEntry(file: TokenFile | null): AuthEntry[] {
  if (file == null) return [];
  const refresh = file.token.refresh_token?.trim() ?? "";
  const access = file.token.access_token?.trim() ?? "";
  if (refresh === "" && access === "") return [];
  const id = accountOwner(file);
  if (id == null) return [{ id: "", usable: false, harvest: null }];
  const harvest: Harvest = {
    id,
    email: idTokenClaims(file).email,
    tier: null,
    sample: null,
    park: async () => {
      writeFileAtomic(agyAuthJsonFor(id), JSON.stringify(file, null, 2), 0o600);
    },
  };
  harvestTokens.set(harvest, file);
  return [{ id, usable: refresh !== "", harvest }];
}

function readAuth(path: string): AuthEntry[] {
  const text = readOptional(path);
  return text == null ? [] : tokenEntry(parseTokenFile(text));
}

function readLiveFile(): AuthEntry[] {
  return readAuth(agyPaths.tokenFile);
}

function readLiveKeychain(): AuthEntry[] {
  if (process.platform !== "darwin") return [];
  const text = readItemSync(KEYRING);
  return text == null ? [] : tokenEntry(parseTokenFile(text));
}

function readLive(): AuthEntry[] {
  const fromFile = readLiveFile();
  return fromFile.length > 0 ? fromFile : readLiveKeychain();
}

function defaultProject(agyHome: string): string {
  for (const key of ["TOKENMAXXING_AGY_PROJECT_ID", "ANTIGRAVITY_PROJECT_ID", "GEMINI_DEFAULT_PROJECT"] as const) {
    const value = env(key, "").trim();
    if (value !== "") return value;
  }
  const cached = readOptional(join(agyHome, "cache", "default_project_id.txt"))?.trim();
  return cached === "" || cached == null ? DEFAULT_PROJECT : cached;
}

function agyUserAgent(agyBin: string): string {
  const p = Bun.spawnSync([agyBin, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL" });
  const version = (p.stdout.toString() + p.stderr.toString()).trim().match(/\d+\.\d+\.\d+/)?.[0] ?? "0.0.0";
  return `antigravity/cli/${version} (tokenmaxxing; os_type=${process.platform}; arch=${process.arch}; auth_method=consumer)`;
}

const TierSchema = z.looseObject({ id: z.string().optional(), name: z.string().optional() });

const CodeAssistSchema = z.looseObject({
  currentTier: TierSchema.optional(),
  paidTier: TierSchema.optional(),
});

const QuotaSummarySchema = z.looseObject({
  groups: z
    .array(
      z.looseObject({
        displayName: z.string().optional(),
        buckets: z.array(
          z.looseObject({
            window: z.string().optional(),
            bucketId: z.string().optional(),
            remainingFraction: z.number().optional(),
            resetTime: z.string().optional(),
          }),
        ),
      }),
    )
    .optional(),
});

function tierLabel(file: TokenFile, assist: z.infer<typeof CodeAssistSchema>): string | null {
  const tiers = [assist.paidTier, assist.currentTier];
  for (const tier of tiers) {
    const id = tier?.id?.trim().toLowerCase() ?? "";
    const name =
      id === "free-tier"
        ? "free"
        : id === "standard-tier"
          ? "standard"
          : id === "g1-pro-tier"
            ? "pro"
            : id === "g1-ultra-tier"
              ? "ultra"
              : "";
    if (name !== "") return name;
    const raw = tier?.name?.trim().toLowerCase();
    if (raw) return raw;
  }
  if (file.auth_method?.toLowerCase() === AUTH_METHOD_GCP) return "paygo";
  return null;
}

function parseReset(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function bucketKind(window: string | undefined, bucketId: string | undefined): "5h" | "weekly" | "" {
  const normalized = window?.trim().toLowerCase() ?? "";
  if (["5h", "5-hour", "five_hour", "five-hour"].includes(normalized)) return "5h";
  if (["weekly", "week"].includes(normalized)) return "weekly";
  const id = (bucketId ?? "").toLowerCase();
  if (id.includes("weekly")) return "weekly";
  if (id.includes("5h") || id.includes("five")) return "5h";
  return "";
}

type QuotaPick = { remaining: number; resetsAt: number | null; group: string | null };

function lowerQuota(current: QuotaPick | null, candidate: QuotaPick): QuotaPick {
  if (current == null) return candidate;
  if (candidate.remaining < current.remaining) return candidate;
  if (candidate.remaining === current.remaining && candidate.resetsAt != null) {
    if (current.resetsAt == null || candidate.resetsAt < current.resetsAt) return candidate;
  }
  return current;
}

function quotaWindows(summary: z.infer<typeof QuotaSummarySchema>, now: number): Window[] {
  let fiveHour: QuotaPick | null = null;
  let weekly: QuotaPick | null = null;
  for (const group of summary.groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.remainingFraction == null) continue;
      const kind = bucketKind(bucket.window, bucket.bucketId);
      if (kind === "") continue;
      const candidate: QuotaPick = {
        remaining: Math.min(1, Math.max(0, bucket.remainingFraction)),
        resetsAt: parseReset(bucket.resetTime),
        group: group.displayName?.trim() || null,
      };
      if (kind === "5h") fiveHour = lowerQuota(fiveHour, candidate);
      else weekly = lowerQuota(weekly, candidate);
    }
  }
  const windows: Window[] = [];
  if (fiveHour != null) {
    windows.push({
      name: null,
      usedPercentage: Math.min(100, Math.max(0, Math.round((1 - fiveHour.remaining) * 100))),
      resetsAt: fiveHour.resetsAt,
      windowSeconds: SESSION_S,
      sampledAt: now,
    });
  }
  if (weekly != null) {
    windows.push({
      name: fiveHour != null ? "week" : null,
      usedPercentage: Math.min(100, Math.max(0, Math.round((1 - weekly.remaining) * 100))),
      resetsAt: weekly.resetsAt,
      windowSeconds: WEEK_S,
      sampledAt: now,
    });
  }
  return windows;
}

async function codeAssistPost<T>(input: { method: string; body: unknown; accessToken: string; userAgent: string; schema: z.ZodType<T> }): Promise<T | null> {
  const origin = env("TOKENMAXXING_AGY_API_URL", "https://daily-cloudcode-pa.googleapis.com/v1internal");
  let res: Response;
  try {
    res = await http.post(`${origin.replace(/\/+$/, "")}:${input.method}`, {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": input.userAgent,
      },
      json: input.body,
    });
  } catch {
    return null;
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}:${safeErrorDetail({ text })}`);
  return input.schema.safeParse(JsonTextSchema.safeParse(text).data).data ?? null;
}

async function accessTokenFor(file: TokenFile, agyBin: string, now: number): Promise<string> {
  const direct = file.token.access_token?.trim() ?? "";
  if (direct !== "" && !tokenExpired(file, now)) return direct;
  const refresh = file.token.refresh_token?.trim() ?? "";
  if (refresh === "") throw new AgyRefreshFailedError("no refresh_token in this account's store");
  return refreshAgyAccessToken({ refreshToken: refresh, authMethod: file.auth_method ?? "consumer", agyBin });
}

async function readAgyUsage(account: Account, now: number): Promise<SampleReport> {
  let file: TokenFile | null;
  try {
    const text = readOptional(agyAuthJsonFor(account.id));
    file = text == null ? null : parseTokenFile(text);
  } catch (e) {
    return { ok: false, reason: `this account's store is unreadable (${errorMessage(e)}) - run \`tokenmaxxing auth --agy\`` };
  }
  if (file == null || (file.token.refresh_token?.trim() ?? "") === "") {
    return { ok: false, reason: "no Antigravity login in this account's store - run `tokenmaxxing auth --agy`" };
  }
  const cfg = loadConfig();
  const agyBin = resolveRealBin({ name: "agy", key: "agyBin" });
  let accessToken: string;
  try {
    accessToken = await accessTokenFor(file, agyBin, now);
  } catch (e) {
    const detail = e instanceof AgyRefreshFailedError ? e.message : errorMessage(e);
    account.needsReauth = true;
    return { ok: false, reason: `${detail} - run \`tokenmaxxing auth --agy\`` };
  }
  const project = file.project_id?.trim() || defaultProject(agyPaths.home);
  const userAgent = agyUserAgent(agyBin);
  let assist: z.infer<typeof CodeAssistSchema> | null;
  try {
    assist = await codeAssistPost({
      method: "loadCodeAssist",
      accessToken,
      userAgent,
      body: {
        cloudaicompanionProject: project,
        metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI", duetProject: project },
      },
      schema: CodeAssistSchema,
    });
  } catch (e) {
    const http = /HTTP (401|403):/.exec(errorMessage(e));
    if (http) {
      account.needsReauth = true;
      return { ok: false, reason: `Antigravity rejected the stored login (${http[0].slice(0, -1)}) - run \`tokenmaxxing auth --agy\`` };
    }
    return { ok: false, reason: `Antigravity usage read failed: ${errorMessage(e)}` };
  }
  if (assist == null) return { ok: false, reason: "Antigravity usage read failed: loadCodeAssist returned an unexpected body shape (withheld)" };
  let summary: z.infer<typeof QuotaSummarySchema> | null;
  try {
    summary = await codeAssistPost({
      method: "retrieveUserQuotaSummary",
      accessToken,
      userAgent,
      body: { project },
      schema: QuotaSummarySchema,
    });
  } catch (e) {
    const http = /HTTP (401|403):/.exec(errorMessage(e));
    if (http) {
      account.needsReauth = true;
      return { ok: false, reason: `Antigravity rejected the stored login (${http[0].slice(0, -1)}) - run \`tokenmaxxing auth --agy\`` };
    }
    return { ok: false, reason: `Antigravity usage read failed: ${errorMessage(e)}` };
  }
  if (summary == null) return { ok: false, reason: "Antigravity usage read failed: retrieveUserQuotaSummary returned an unexpected body shape (withheld)" };
  const windows = quotaWindows(summary, now);
  if (windows.length === 0) return { ok: false, reason: "Antigravity reports no quota window for this account" };
  account.windows = windows;
  account.lastUsageAt = now;
  const tier = tierLabel(file, assist);
  if (tier) account.tier = tier;
  const email = idTokenClaims(file).email;
  if (email && account.email == null) account.email = email;
  return { ok: true, source: "probe" };
}

async function identify(harvest: Harvest): Promise<void> {
  const file = harvestTokens.get(harvest);
  if (file == null) return;
  const owner = accountOwner(file);
  if (owner == null) throw new Error("Antigravity left a credential without a usable account identity - nothing pooled");
  harvest.id = owner;
  const email = idTokenClaims(file).email;
  if (email) harvest.email = email;
}

async function samplePool(accounts: Account[], now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(accounts.map(async (account) => reports.set(account.id, await readAgyUsage(account, now))));
  return reports;
}

export const agy = statusOnlyProvider({
  name: "agy",
  flag: " --agy",
  pool: agyPool,
  bin: { name: "agy", key: "agyBin", versionOk: (out) => /^\d+\.\d+\.\d+/.test(out.trim()) && !/\bvibe\b/i.test(out) },
  storeDirFor: agyStoreDirFor,
  authJsonFor: agyAuthJsonFor,
  homeEnv: "HOME",
  loginArgs: () => [],
  loginEnv: { DBUS_SESSION_BUS_ADDRESS: "", XDG_RUNTIME_DIR: "", AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
  onboardAuthRel: join(".gemini", "antigravity-cli", "antigravity-oauth-token"),
  readAuth,
  liveId: () => null,
  presence: () => new Map(),
  importIntro: "Pooling your first Google Antigravity account - the login you already have stays as it is.",
  live: {
    read: readLive,
    found: () => `found the Antigravity login that agy uses - pooling it; use \`tokenmaxxing add --agy\` for more.`,
  },
  install: () => {
    console.log(c.dim("agy pool is status-only: no supervisor or hooks installed. Use `tokenmaxxing status` to view pooled Antigravity accounts."));
  },
  loginStep: () => `Sign in when ${c.bold("agy")} opens (browser OAuth on first launch, or complete /login in the TUI).`,
  samplePool,
  identify,
});