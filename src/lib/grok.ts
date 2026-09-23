import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { fetchGrokUsage, GrokUsageReadError, type GrokUsage } from "./grokusage.ts";
import { errorMessage } from "./log.ts";
import { grokAuthJsonFor, grokPaths, grokPool, grokSeatFromEnv, grokStoreDirFor } from "./paths.ts";
import type { Provider, SampleReport } from "./provider.ts";
import { loadAccounts, type Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { InstantSchema, type Account } from "./types.ts";
import { c } from "../cli/render.ts";

const GrokAuthEntrySchema = z.looseObject({
  user_id: z.string().optional(),
  principal_id: z.string().optional(),
  email: z.string().nullish(),
  first_name: z.string().nullish(),
  key: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_at: z.string().nullish(),
});
type GrokAuthEntry = z.infer<typeof GrokAuthEntrySchema>;

type GrokCred = { id: string; token: string; expiresAt: number | null };

function harvestOf(id: string, key: string, entry: GrokAuthEntry): Harvest {
  return {
    id,
    email: entry.email ?? null,
    tier: null,
    sample: null,
    park: async () => {
      writeFileAtomic(grokAuthJsonFor(id), JSON.stringify({ [key]: entry }, null, 2), 0o600);
    },
  };
}

function readMap(path: string): [string, GrokAuthEntry][] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const map = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!map.success) return [];
  const out: [string, GrokAuthEntry][] = [];
  for (const [key, value] of Object.entries(map.data)) {
    const parsed = GrokAuthEntrySchema.safeParse(value);
    if (!parsed.success) continue;
    out.push([key, parsed.data]);
  }
  return out;
}

function readAuth(path: string): AuthEntry[] {
  const out: AuthEntry[] = [];
  for (const [key, entry] of readMap(path)) {
    const id = entry.user_id ?? entry.principal_id ?? key;
    out.push({ id, usable: (entry.refresh_token ?? "") !== "", harvest: id === "" ? null : harvestOf(id, key, entry) });
  }
  return out;
}

function credsIn(path: string): GrokCred[] {
  const out: GrokCred[] = [];
  for (const [key, entry] of readMap(path)) {
    const id = entry.user_id ?? entry.principal_id ?? key;
    const token = entry.key ?? "";
    if (id === "" || token === "") continue;
    out.push({ id, token, expiresAt: InstantSchema.safeParse(entry.expires_at).data ?? null });
  }
  return out;
}

function liveCred(accountId: string): GrokCred | null {
  return credsIn(join(grokPaths.home, "auth.json")).find((c) => c.id === accountId) ?? null;
}

function bearerFor(accountId: string, now: number): { token: string; from: "store" | "live" } | null {
  const store = credsIn(grokAuthJsonFor(accountId)).find((c) => c.id === accountId) ?? null;
  const live = liveCred(accountId);
  if (store != null && (store.expiresAt == null || store.expiresAt > now + 60_000)) return { token: store.token, from: "store" };
  if (live != null) return { token: live.token, from: "live" };
  if (store != null) return { token: store.token, from: "store" };
  return null;
}

async function readGrokUsage(account: Account, now: number): Promise<{ ok: true; at: number } | { ok: false; reason: string }> {
  const first = bearerFor(account.id, now);
  if (first == null) return { ok: false, reason: "no usable credential in this account's store - run `tokenmaxxing auth --grok`" };
  let usage: GrokUsage;
  try {
    usage = await fetchGrokUsage({ token: first.token, at: now });
  } catch (e) {
    const live = e instanceof GrokUsageReadError && e.status === 401 && first.from === "store" ? liveCred(account.id) : null;
    if (live == null || live.token === first.token) return { ok: false, reason: errorMessage(e) };
    try {
      usage = await fetchGrokUsage({ token: live.token, at: now });
    } catch (retry) {
      return { ok: false, reason: errorMessage(retry) };
    }
  }
  account.windows = usage.windows;
  account.lastUsageAt = usage.at;
  return { ok: true, at: usage.at };
}

async function samplePool(accounts: Account[], _liveId: string | null, now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(
    accounts.map(async (account) => {
      const outcome = await readGrokUsage(account, now);
      reports.set(account.id, outcome.ok ? { ok: true, source: "probe" } : { ok: false, reason: outcome.reason });
    }),
  );
  return reports;
}

const base = statusOnlyProvider({
  name: "grok",
  flag: " --grok",
  pool: grokPool,
  binName: "grok",
  binKey: "grokBin",
  storeDirFor: grokStoreDirFor,
  authJsonFor: grokAuthJsonFor,
  onboardDir: grokPaths.onboardDir,
  homeEnv: "GROK_HOME",
  loginArgs: ["login"],
  onboardAuthRel: "auth.json",
  liveAuthPath: () => join(grokPaths.home, "auth.json"),
  readAuth,
  liveId: () => grokSeatFromEnv(loadAccounts(grokPool).accounts.map((a) => a.id)),
  versionOk: (out) => out.toLowerCase().includes("grok"),
  importIntro: "Opening an isolated grok login for your first pooled account - the login you already have stays as it is.",
  foundLive: (count) => `found ${count} grok login(s) in ${grokPaths.home} - pooling the first; use \`tokenmaxxing add --grok\` for the rest.`,
  installNotice: "grok pool is status-only: no supervisor or hooks installed. Use `tokenmaxxing status` to view pooled grok accounts.",
  loginStep: () => `Sign in in the browser session that opens (or run ${c.bold("grok login --device-auth")} on headless hosts first).`,
});

export const grok: Provider = {
  ...base,
  samplePool,
};
