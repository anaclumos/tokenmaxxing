import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { http, safeErrorDetail } from "./http.ts";
import { errorMessage } from "./log.ts";
import { cursorAuthJsonFor, cursorPaths, cursorPool, cursorStoreDirFor, env } from "./paths.ts";
import type { SampleReport } from "./provider.ts";
import { readJsonFile, type Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { ErrnoSchema, JsonTextSchema, type Account, type Window } from "./types.ts";
import { c } from "../cli/render.ts";

const CursorAuthSchema = z.looseObject({ accessToken: z.string().optional() });
type CursorAuth = z.infer<typeof CursorAuthSchema>;

const CliConfigSchema = z.looseObject({
  authInfo: z.looseObject({ authId: z.string().optional(), email: z.string().nullish() }).optional(),
});

const JwtPayloadSchema = z.looseObject({ sub: z.string().min(1) });

function readOptional<T>(path: string, schema: z.ZodType<T>): T | null {
  try {
    return readJsonFile(path, schema);
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return null;
    throw e;
  }
}

function tokenSubject(token: string): string | null {
  const payload = token.split(".")[1] ?? "";
  return JwtPayloadSchema.safeParse(JsonTextSchema.safeParse(Buffer.from(payload, "base64url").toString("utf8")).data).data?.sub ?? null;
}

// The CLI caches the signed-in user next to auth.json; it is the only local copy of the email, because the token carries none.
function cachedEmail(authPath: string, subject: string): string | null {
  let config: z.infer<typeof CliConfigSchema> | null;
  try {
    config = readOptional(join(dirname(authPath), "cli-config.json"), CliConfigSchema);
  } catch {
    return null;
  }
  const info = config?.authInfo;
  if (info?.authId !== subject) return null;
  const email = info.email?.trim().toLowerCase() ?? "";
  return email === "" ? null : email;
}

function readAuth(path: string): AuthEntry[] {
  const file: CursorAuth | null = readOptional(path, CursorAuthSchema);
  const token = file?.accessToken ?? "";
  if (file == null || token === "") return [];
  const subject = tokenSubject(token);
  if (subject == null) return [{ id: "", usable: false, harvest: null }];
  const id = new Bun.CryptoHasher("sha256").update(subject).digest("hex");
  const harvest: Harvest = {
    id,
    email: cachedEmail(path, subject),
    tier: null,
    sample: null,
    park: async () => {
      writeFileAtomic(cursorAuthJsonFor(id), JSON.stringify(file, null, 2), 0o600);
    },
  };
  return [{ id, usable: true, harvest }];
}

const EpochMsSchema = z.coerce.number();

const PeriodUsageSchema = z.looseObject({
  billingCycleStart: EpochMsSchema,
  billingCycleEnd: EpochMsSchema,
  planUsage: z
    .looseObject({
      includedSpend: z.number().default(0),
      limit: z.number().default(0),
      totalPercentUsed: z.number().optional(),
      apiPercentUsed: z.number().optional(),
    })
    .optional(),
});

const PlanInfoSchema = z.looseObject({ planInfo: z.looseObject({ planName: z.string().optional() }).optional() });

const MeSchema = z.looseObject({ email: z.string().optional() });

function dashboardUrl(method: string): string {
  return `${env("TOKENMAXXING_CURSOR_API_URL", "https://api2.cursor.sh")}/aiserver.v1.DashboardService/${method}`;
}

async function dashboard(token: string, method: string): Promise<Response> {
  return http.post(dashboardUrl(method), { headers: { Authorization: `Bearer ${token}`, "Connect-Protocol-Version": "1" }, json: {} });
}

async function dashboardField<T>(token: string, method: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const res = await dashboard(token, method);
    return res.ok ? (schema.safeParse(JsonTextSchema.safeParse(await res.text()).data).data ?? null) : null;
  } catch {
    return null;
  }
}

async function readCursorUsage(account: Account, now: number): Promise<SampleReport> {
  let token: string;
  try {
    token = readOptional(cursorAuthJsonFor(account.id), CursorAuthSchema)?.accessToken ?? "";
  } catch (e) {
    return { ok: false, reason: `this account's store is unreadable (${errorMessage(e)}) - run \`tokenmaxxing auth --cursor\`` };
  }
  if (token === "") return { ok: false, reason: "no accessToken in this account's store - run `tokenmaxxing auth --cursor`" };
  let res: Response;
  let text: string;
  const plan = dashboardField(token, "GetPlanInfo", PlanInfoSchema);
  const me = account.email == null ? dashboardField(token, "GetMe", MeSchema) : null;
  try {
    res = await dashboard(token, "GetCurrentPeriodUsage");
    text = await res.text();
  } catch (e) {
    return { ok: false, reason: `Cursor usage read failed: endpoint unreachable: ${errorMessage(e)}` };
  }
  if (res.status === 401 || res.status === 403) {
    account.needsReauth = true;
    return { ok: false, reason: `Cursor rejected the stored login (HTTP ${res.status}) - run \`tokenmaxxing auth --cursor\`` };
  }
  if (!res.ok) return { ok: false, reason: `Cursor usage read failed: HTTP ${res.status}: ${safeErrorDetail({ text })}` };
  const parsed = PeriodUsageSchema.safeParse(JsonTextSchema.safeParse(text).data);
  if (!parsed.success) return { ok: false, reason: "Cursor usage read failed: endpoint returned an unexpected body shape (withheld)" };
  const { billingCycleStart, billingCycleEnd, planUsage } = parsed.data;
  const total = planUsage?.totalPercentUsed ?? (planUsage != null && planUsage.limit > 0 ? Math.min(100, (planUsage.includedSpend / planUsage.limit) * 100) : null);
  if (total == null) return { ok: false, reason: "Cursor reports no included-usage limit for this account" };
  const cycle = { resetsAt: billingCycleEnd, windowSeconds: billingCycleEnd > billingCycleStart ? Math.round((billingCycleEnd - billingCycleStart) / 1000) : null, sampledAt: now };
  const windows: Window[] = [{ name: null, usedPercentage: total, ...cycle }];
  if (planUsage?.apiPercentUsed != null) windows.push({ name: "API", usedPercentage: planUsage.apiPercentUsed, ...cycle });
  account.windows = windows;
  account.lastUsageAt = now;
  const planName = (await plan)?.planInfo?.planName?.trim().toLowerCase();
  if (planName) account.tier = planName;
  const email = (await me)?.email?.trim().toLowerCase();
  if (email) account.email = email;
  return { ok: true, source: "probe" };
}

async function samplePool(accounts: Account[], now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(accounts.map(async (account) => reports.set(account.id, await readCursorUsage(account, now))));
  return reports;
}

export const cursor = statusOnlyProvider({
  name: "cursor",
  flag: " --cursor",
  pool: cursorPool,
  binName: "cursor-agent",
  binKey: "cursorBin",
  storeDirFor: cursorStoreDirFor,
  authJsonFor: cursorAuthJsonFor,
  homeEnv: "XDG_CONFIG_HOME",
  loginArgs: ["login"],
  onboardAuthRel: "cursor/auth.json",
  liveAuthPath: () => cursorPaths.authJson,
  readAuth,
  liveId: () => null,
  presence: () => new Map(),
  versionOk: (out) => /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/.test(out.trim()),
  importIntro: "Opening an isolated Cursor login for your first pooled account - the login you already have stays as it is.",
  foundLive: () => `found the Cursor login in ${cursorPaths.authJson} - pooling it; use \`tokenmaxxing add --cursor\` for more.`,
  installNotice: "cursor pool is status-only: no supervisor or hooks installed. Use `tokenmaxxing status` to view pooled Cursor accounts.",
  loginStep: () => `Approve the login in the browser that ${c.bold("cursor-agent login")} opens.`,
  samplePool,
});
