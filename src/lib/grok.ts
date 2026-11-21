import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { GROK_BIN } from "./claudebin.ts";
import { fetchGrokUsage, GrokUsageReadError } from "./grokusage.ts";
import { errorMessage } from "./log.ts";
import { grokAuthJsonFor, grokPaths, grokPool, grokStoreDirFor } from "./paths.ts";
import type { SampleReport } from "./provider.ts";
import { readJsonFile, type Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { ErrnoSchema, InstantSchema, type Account, type Window } from "./types.ts";
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

function accountIdOf(entry: GrokAuthEntry, key: string): string {
  return entry.user_id ?? entry.principal_id ?? key;
}

function liveGrokAuthPath(): string {
  return join(grokPaths.home, "auth.json");
}

function adoptGrokAuthFromLive(accountId: string): boolean {
  for (const [key, entry] of readMap(liveGrokAuthPath())) {
    if (accountIdOf(entry, key) !== accountId) continue;
    writeFileAtomic(grokAuthJsonFor(accountId), JSON.stringify({ [key]: entry }, null, 2), 0o600);
    return true;
  }
  return false;
}

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
  let map: Record<string, unknown>;
  try {
    map = readJsonFile(path, z.record(z.string(), z.unknown()));
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return [];
    throw e;
  }
  const out: [string, GrokAuthEntry][] = [];
  for (const [key, value] of Object.entries(map)) {
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
  return credsIn(liveGrokAuthPath()).find((c) => c.id === accountId) ?? null;
}

function bearerFor(accountId: string, now: number): { token: string; from: "store" | "live" } | null {
  const store = credsIn(grokAuthJsonFor(accountId)).find((c) => c.id === accountId) ?? null;
  const live = liveCred(accountId);
  if (store != null && (store.expiresAt == null || store.expiresAt > now + 60_000)) return { token: store.token, from: "store" };
  if (live != null) return { token: live.token, from: "live" };
  if (store != null) return { token: store.token, from: "store" };
  return null;
}

type GrokRead = { ok: true; windows: Window[] } | { ok: false; reason: string; rejected: boolean };

async function readGrokUsage(account: Account, now: number): Promise<GrokRead> {
  let first: { token: string; from: "store" | "live" } | null;
  try {
    first = bearerFor(account.id, now);
  } catch (e) {
    return { ok: false, rejected: false, reason: `this account's store is unreadable (${errorMessage(e)}) - run \`tokenmaxxing auth --grok\`` };
  }
  if (first == null) return { ok: false, rejected: false, reason: "no usable credential in this account's store - run `tokenmaxxing auth --grok`" };
  try {
    return { ok: true, windows: await fetchGrokUsage({ token: first.token, at: now }) };
  } catch (e) {
    const live = e instanceof GrokUsageReadError && e.status === 401 && first.from === "store" ? liveCred(account.id) : null;
    if (live != null && live.token !== first.token) {
      try {
        const windows = await fetchGrokUsage({ token: live.token, at: now });
        adoptGrokAuthFromLive(account.id);
        return { ok: true, windows };
      } catch (retry) {
        const rejected = retry instanceof GrokUsageReadError && retry.status === 401;
        return { ok: false, rejected, reason: errorMessage(retry) };
      }
    }
    const rejected = e instanceof GrokUsageReadError && e.status === 401;
    return { ok: false, rejected, reason: errorMessage(e) };
  }
}

async function samplePool(accounts: Account[], now: number): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  await Promise.all(
    accounts.map(async (account) => {
      const read = await readGrokUsage(account, now);
      if (read.ok) {
        account.windows = read.windows;
        account.lastUsageAt = now;
        delete account.needsReauth;
        reports.set(account.id, { ok: true, source: "probe" });
        return;
      }
      if (read.rejected) account.needsReauth = true;
      reports.set(account.id, { ok: false, reason: read.reason });
    }),
  );
  return reports;
}

export const grok = statusOnlyProvider({
  name: "grok",
  flag: " --grok",
  pool: grokPool,
  bin: GROK_BIN,
  storeDirFor: grokStoreDirFor,
  authJsonFor: grokAuthJsonFor,
  homeEnv: "GROK_HOME",
  loginArgs: () => ["login"],
  onboardAuthRel: "auth.json",
  readAuth,
  liveId: () => null,
  presence: () => new Map(),
  importIntro: "Pooling your grok login from the ambient grok home for usage reporting - the login stays where it is, and any other logins there are left as they are.",
  live: {
    read: () => readAuth(liveGrokAuthPath()),
    found: (count) => `found ${count} grok login(s) in ${grokPaths.home} - pooling the first; use \`tokenmaxxing add --grok\` for the rest.`,
  },
  install: () => {
    console.log(c.dim("grok pool is status-only: usage is reported in `tokenmaxxing status`; no supervisor, hooks, or switching are installed."));
  },
  loginStep: () => `Sign in in the browser session that opens (or run ${c.bold("grok login --device-auth")} on headless hosts first).`,
  samplePool,
});
