import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { http, safeErrorDetail } from "./http.ts";
import { readItemSync } from "./keychain.ts";
import { errorMessage } from "./log.ts";
import { env, vibeAuthJsonFor, vibePaths, vibePool, vibeStoreDirFor } from "./paths.ts";
import type { SampleReport } from "./provider.ts";
import { readJsonFile, type Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { ErrnoSchema, JsonTextSchema, type Account } from "./types.ts";
import { c } from "../cli/render.ts";

const KEY_VAR = "MISTRAL_API_KEY";

const KEY_LINE = new RegExp(`^\\s*(?:export\\s+)?${KEY_VAR}\\s*=\\s*(.*)$`);

const MONTH_S = 30 * 86400;

const StoreSchema = z.object({ id: z.string().min(1), apiKey: z.string() });
type Store = z.infer<typeof StoreSchema>;

const UserSchema = z.looseObject({
  id: z.string().min(1),
  email: z.string().nullish(),
  organization: z.looseObject({ id: z.string().min(1) }).nullish(),
});

const BudgetSchema = z.looseObject({
  vibe_budget: z.looseObject({ usage_percentage: z.number(), initial_budget: z.number(), reset_at: z.string().nullish() }).nullish(),
});

const SubscriptionSchema = z.looseObject({ plan_name: z.string().nullish() });

function isMissing(e: unknown): boolean {
  return ErrnoSchema.safeParse(e).data?.code === "ENOENT";
}

function readStore(path: string): Store | null {
  try {
    return readJsonFile(path, StoreSchema);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

function envKey(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
  let key: string | null = null;
  for (const line of text.split("\n")) {
    const value = KEY_LINE.exec(line)?.[1]?.trim();
    if (value == null) continue;
    const unquoted = /^(['"])(.*?)\1/.exec(value)?.[2] ?? value.split(/\s/)[0] ?? "";
    key = unquoted === "" ? null : unquoted;
  }
  return key;
}

const harvestKeys = new WeakMap<Harvest, string>();

function keyEntries(apiKey: string | null): AuthEntry[] {
  if (apiKey == null) return [];
  const harvest: Harvest = {
    id: "",
    email: null,
    tier: null,
    sample: null,
    park: async () => {
      writeFileAtomic(vibeAuthJsonFor(harvest.id), JSON.stringify({ id: harvest.id, apiKey }, null, 2), 0o600);
    },
  };
  harvestKeys.set(harvest, apiKey);
  return [{ id: "", usable: true, harvest }];
}

function readAuth(path: string): AuthEntry[] {
  if (basename(path) === ".env") return keyEntries(envKey(path));
  const store = readStore(path);
  return store == null ? [] : [{ id: store.id, usable: store.apiKey !== "", harvest: null }];
}

function readLive(): AuthEntry[] {
  const fromFile = readAuth(vibePaths.envFile);
  if (fromFile.length > 0 || process.platform !== "darwin") return fromFile;
  return keyEntries(readItemSync({ service: "ai.mistral.vibe", account: KEY_VAR }));
}

function mistral(apiKey: string, path: string): Promise<Response> {
  return http.get(`${env("TOKENMAXXING_VIBE_API_URL", "https://api.mistral.ai")}/v1/${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
}

async function mistralField<T>(apiKey: string, path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const res = await mistral(apiKey, path);
    return res.ok ? (schema.safeParse(JsonTextSchema.safeParse(await res.text()).data).data ?? null) : null;
  } catch {
    return null;
  }
}

async function identify(harvest: Harvest): Promise<void> {
  const apiKey = harvestKeys.get(harvest);
  if (apiKey == null) return;
  const res = await mistral(apiKey, "users/me");
  const text = await res.text();
  if (!res.ok) throw new Error(`Mistral refused that Vibe API key (HTTP ${res.status}: ${safeErrorDetail({ text })}) - nothing pooled`);
  const user = UserSchema.safeParse(JsonTextSchema.safeParse(text).data);
  if (!user.success) throw new Error("Mistral returned an unexpected user body shape (withheld) - nothing pooled");
  const owner = user.data.organization == null ? user.data.id : `${user.data.id}:${user.data.organization.id}`;
  harvest.id = new Bun.CryptoHasher("sha256").update(owner).digest("hex");
  harvest.email = user.data.email?.trim().toLowerCase() || null;
}

async function readVibeUsage(account: Account, now: number): Promise<SampleReport> {
  let apiKey: string;
  try {
    apiKey = readStore(vibeAuthJsonFor(account.id))?.apiKey ?? "";
  } catch (e) {
    return { ok: false, reason: `this account's store is unreadable (${errorMessage(e)}) - run \`tokenmaxxing auth --vibe\`` };
  }
  if (apiKey === "") return { ok: false, reason: "no API key in this account's store - run `tokenmaxxing auth --vibe`" };
  const plan = mistralField(apiKey, "billing/subscription", SubscriptionSchema);
  const user = account.email == null ? mistralField(apiKey, "users/me", UserSchema) : null;
  let res: Response;
  let text: string;
  try {
    res = await mistral(apiKey, "billing/budget");
    text = await res.text();
  } catch (e) {
    return { ok: false, reason: `Mistral usage read failed: endpoint unreachable: ${errorMessage(e)}` };
  }
  if (res.status === 401) {
    account.needsReauth = true;
    return { ok: false, reason: "Mistral rejected the stored API key (HTTP 401) - run `tokenmaxxing auth --vibe`" };
  }
  if (!res.ok) return { ok: false, reason: `Mistral usage read failed: HTTP ${res.status}: ${safeErrorDetail({ text })}` };
  const parsed = BudgetSchema.safeParse(JsonTextSchema.safeParse(text).data);
  if (!parsed.success) return { ok: false, reason: "Mistral usage read failed: endpoint returned an unexpected body shape (withheld)" };
  const budget = parsed.data.vibe_budget;
  if (budget == null || budget.initial_budget <= 0) return { ok: false, reason: "Mistral reports no Vibe allowance for this account" };
  const resetsAt = budget.reset_at == null ? Number.NaN : Date.parse(budget.reset_at);
  account.windows = [
    { name: null, usedPercentage: Math.min(100, Math.max(0, budget.usage_percentage)), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null, windowSeconds: MONTH_S, sampledAt: now },
  ];
  account.lastUsageAt = now;
  const tier = (await plan)?.plan_name?.trim().toLowerCase();
  if (tier) account.tier = tier;
  const email = (await user)?.email?.trim().toLowerCase();
  if (email) account.email = email;
  return { ok: true, source: "probe" };
}

async function samplePool(accounts: Account[], now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(accounts.map(async (account) => reports.set(account.id, await readVibeUsage(account, now))));
  return reports;
}

export const vibe = statusOnlyProvider({
  name: "vibe",
  flag: " --vibe",
  pool: vibePool,
  bin: { name: "vibe", key: "vibeBin", versionOk: (out) => /^vibe \d+\.\d+\.\d+/.test(out.trim()) },
  storeDirFor: vibeStoreDirFor,
  authJsonFor: vibeAuthJsonFor,
  homeEnv: "VIBE_HOME",
  loginArgs: () => ["--setup"],
  loginEnv: { VIBE_TEST_DISABLE_KEYRING: "1", VIBE_CLI_OIDC_ENABLED: undefined, [KEY_VAR]: undefined },
  onboardAuthRel: ".env",
  readAuth,
  liveId: () => null,
  presence: () => new Map(),
  importIntro: "Pooling your first Mistral Vibe account - the login you already have stays as it is.",
  live: {
    read: readLive,
    found: () => "found the API key that `vibe` signs in with - pooling it; use `tokenmaxxing add --vibe` for more.",
  },
  install: () => {
    console.log(c.dim("vibe pool is status-only: no supervisor or hooks installed. Use `tokenmaxxing status` to view pooled Mistral Vibe accounts."));
  },
  loginStep: () => `Sign in or paste an API key in the setup that ${c.bold("vibe --setup")} opens.`,
  samplePool,
  identify,
});
