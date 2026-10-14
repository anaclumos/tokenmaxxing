import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { http, safeErrorDetail } from "./http.ts";
import { errorMessage } from "./log.ts";
import { env, museAuthJsonFor, musePaths, musePool, museStoreDirFor } from "./paths.ts";
import type { SampleReport } from "./provider.ts";
import { readJsonFile, type Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { EpochSecondsSchema, ErrnoSchema, JsonTextSchema, type Account } from "./types.ts";
import { c } from "../cli/render.ts";

const MuseProviderSchema = z.looseObject({
  access_token: z.string().optional(),
  user_email: z.string().nullish(),
});

const MuseAuthSchema = z.looseObject({
  providers: z.record(z.string(), z.unknown()),
});
type MuseAuth = z.infer<typeof MuseAuthSchema>;

function readFile(path: string): MuseAuth | null {
  try {
    return readJsonFile(path, MuseAuthSchema);
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return null;
    throw e;
  }
}

function readAuth(path: string): AuthEntry[] {
  const file = readFile(path);
  if (file == null) return [];
  const out: AuthEntry[] = [];
  for (const [key, value] of Object.entries(file.providers)) {
    const parsed = MuseProviderSchema.safeParse(value);
    if (!parsed.success) continue;
    const email = parsed.data.user_email?.trim().toLowerCase() ?? "";
    const id = email === "" ? "" : new Bun.CryptoHasher("sha256").update(email).digest("hex");
    const harvest: Harvest | null =
      id === ""
        ? null
        : {
            id,
            email,
            tier: null,
            sample: null,
            park: async () => {
              writeFileAtomic(museAuthJsonFor(id), JSON.stringify({ ...file, providers: { [key]: value } }, null, 2), 0o600);
            },
          };
    out.push({ id, usable: (parsed.data.access_token ?? "") !== "", harvest });
  }
  return out;
}

const SubscriptionWindowSchema = z.looseObject({ used_percent: z.number(), resets_at: EpochSecondsSchema });

const MintSchema = z.looseObject({
  subs_usage: z
    .looseObject({
      window: SubscriptionWindowSchema.extend({ window_duration_mins: z.number() }),
      weekly: SubscriptionWindowSchema,
    })
    .nullable(),
});

const WEEK_S = 7 * 86400;

function usageUrl(): string {
  return env("TOKENMAXXING_MUSE_USAGE_URL", "https://api.meta.ai/muse-code/key");
}

function storedAccessToken(id: string): string | null {
  const file = readFile(museAuthJsonFor(id));
  if (file == null) return null;
  for (const value of Object.values(file.providers)) {
    const token = MuseProviderSchema.safeParse(value).data?.access_token ?? "";
    if (token !== "") return token;
  }
  return null;
}

async function readMuseUsage(account: Account, now: number): Promise<SampleReport> {
  let token: string | null;
  try {
    token = storedAccessToken(account.id);
  } catch (e) {
    return { ok: false, reason: `this account's store is unreadable (${errorMessage(e)}) - run \`tokenmaxxing auth --muse\`` };
  }
  if (token == null) return { ok: false, reason: "no access_token in this account's store - run `tokenmaxxing auth --muse`" };
  let res: Response;
  let text: string;
  try {
    res = await http.post(usageUrl(), { headers: { Authorization: `Bearer ${token}` }, json: {} });
    text = await res.text();
  } catch (e) {
    return { ok: false, reason: `Muse Code usage read failed: endpoint unreachable: ${errorMessage(e)}` };
  }
  if (res.status === 401 || res.status === 403) {
    account.needsReauth = true;
    return { ok: false, reason: `Muse Code rejected the stored login (HTTP ${res.status}) - run \`tokenmaxxing auth --muse\`` };
  }
  if (!res.ok) return { ok: false, reason: `Muse Code usage read failed: HTTP ${res.status}: ${safeErrorDetail({ text })}` };
  const parsed = MintSchema.safeParse(JsonTextSchema.safeParse(text).data);
  if (!parsed.success) return { ok: false, reason: "Muse Code usage read failed: endpoint returned an unexpected body shape (withheld)" };
  if (parsed.data.subs_usage == null) return { ok: false, reason: "Muse Code reports no usage until a model request opens the 5-hour window" };
  const { window, weekly } = parsed.data.subs_usage;
  account.windows = [
    { name: null, usedPercentage: window.used_percent, resetsAt: window.resets_at, windowSeconds: window.window_duration_mins * 60, sampledAt: now },
    { name: null, usedPercentage: weekly.used_percent, resetsAt: weekly.resets_at, windowSeconds: WEEK_S, sampledAt: now },
  ];
  account.lastUsageAt = now;
  return { ok: true, source: "probe" };
}

async function samplePool(accounts: Account[], now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(accounts.map(async (account) => reports.set(account.id, await readMuseUsage(account, now))));
  return reports;
}

export const muse = statusOnlyProvider({
  name: "muse",
  flag: " --muse",
  pool: musePool,
  binName: "muse",
  binKey: "museBin",
  storeDirFor: museStoreDirFor,
  authJsonFor: museAuthJsonFor,
  homeEnv: "XDG_CONFIG_HOME",
  loginArgs: ["login"],
  onboardAuthRel: "muse/auth.json",
  liveAuthPath: () => musePaths.authJson,
  readAuth,
  liveId: () => null,
  presence: () => new Map(),
  versionOk: (out) => out.toLowerCase().includes("muse code"),
  importIntro: "Opening an isolated Muse Code login for your first pooled account - the login you already have stays as it is.",
  foundLive: (count) => `found ${count} Muse Code login(s) in ${musePaths.authJson} - pooling the first; use \`tokenmaxxing add --muse\` for the rest.`,
  installNotice: "muse pool is status-only: no supervisor or hooks installed. Use `tokenmaxxing status` to view pooled Muse Code accounts.",
  loginStep: () => `Approve the code in the browser that ${c.bold("muse login")} opens.`,
  samplePool,
});
