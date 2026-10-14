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
  api_key: z.string().optional(),
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
    out.push({ id, usable: (parsed.data.access_token ?? "") !== "" || (parsed.data.api_key ?? "") !== "", harvest });
  }
  return out;
}

const SubscriptionWindowSchema = z.looseObject({ used_percent: z.number(), resets_at: EpochSecondsSchema });

const SubscriptionUsageSchema = z.looseObject({
  type: z.literal("response.subscription_usage"),
  subscription: z.looseObject({
    window: SubscriptionWindowSchema.extend({ window_duration_mins: z.number() }),
    weekly: SubscriptionWindowSchema,
  }),
});

const WEEK_S = 7 * 86400;

function usageUrl(): string {
  return env("TOKENMAXXING_MUSE_USAGE_URL", "https://api.meta.ai/v1/responses");
}

function storedKey(id: string): string | null {
  const file = readFile(museAuthJsonFor(id));
  if (file == null) return null;
  for (const value of Object.values(file.providers)) {
    const key = MuseProviderSchema.safeParse(value).data?.api_key ?? "";
    if (key !== "") return key;
  }
  return null;
}

function subscriptionFrame(text: string): z.infer<typeof SubscriptionUsageSchema> | null {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const frame = SubscriptionUsageSchema.safeParse(JsonTextSchema.safeParse(line.slice("data: ".length)).data);
    if (frame.success) return frame.data;
  }
  return null;
}

async function readMuseUsage(account: Account, now: number): Promise<SampleReport> {
  const key = storedKey(account.id);
  if (key == null) return { ok: false, reason: "no api_key in this account's store - run `tokenmaxxing auth --muse`" };
  let res: Response;
  try {
    res = await http.post(usageUrl(), {
      headers: { Authorization: `Bearer ${key}`, Accept: "text/event-stream" },
      json: { model: "muse-spark-1.3", input: "hi", max_output_tokens: 16, stream: true },
    });
  } catch (e) {
    return { ok: false, reason: `Muse Code usage read failed: endpoint unreachable: ${errorMessage(e)}` };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, reason: `Muse Code usage read failed: HTTP ${res.status}: ${safeErrorDetail({ text })}` };
  const frame = subscriptionFrame(text);
  if (frame == null) return { ok: false, reason: "Muse Code usage read failed: the response stream carried no response.subscription_usage event" };
  const { window, weekly } = frame.subscription;
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
