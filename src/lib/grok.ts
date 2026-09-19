import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { grokAuthJsonFor, grokPaths, grokPool, grokSeatFromEnv, grokStoreDirFor } from "./paths.ts";
import type { Provider } from "./provider.ts";
import { loadAccounts, type Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { c } from "../cli/render.ts";

const GrokAuthEntrySchema = z.looseObject({
  user_id: z.string().optional(),
  principal_id: z.string().optional(),
  email: z.string().nullish(),
  first_name: z.string().nullish(),
  refresh_token: z.string().optional(),
  expires_at: z.string().nullish(),
});
type GrokAuthEntry = z.infer<typeof GrokAuthEntrySchema>;

function harvestOf(id: string, key: string, entry: GrokAuthEntry): Harvest {
  return {
    id,
    email: entry.email ?? null,
    tier: null,
    sample: null,
    park: async () => {
      mkdirSync(grokStoreDirFor(id), { recursive: true });
      writeFileAtomic(grokAuthJsonFor(id), JSON.stringify({ [key]: entry }, null, 2), 0o600);
    },
  };
}

function readAuth(path: string): AuthEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const map = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!map.success) return [];
  const out: AuthEntry[] = [];
  for (const [key, value] of Object.entries(map.data)) {
    const parsed = GrokAuthEntrySchema.safeParse(value);
    if (!parsed.success) continue;
    const entry = parsed.data;
    const id = entry.user_id ?? entry.principal_id ?? key;
    out.push({ id, usable: (entry.refresh_token ?? "") !== "", harvest: id === "" ? null : harvestOf(id, key, entry) });
  }
  return out;
}

export const grok: Provider = statusOnlyProvider({
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
  versionOk: (out) => out.trim().toLowerCase().includes("grok"),
  importIntro: "Opening an isolated grok login for your first pooled account - the login you already have stays as it is.",
  foundLive: (count) => `found ${count} grok login(s) in ${grokPaths.home} - pooling the first; use \`tokenmaxxing add --grok\` for the rest.`,
  installNotice: "grok pool is status-only: no supervisor or hooks installed. Use `tokenmaxxing status` to view pooled grok accounts.",
  loginStep: () => `Sign in in the browser session that opens (or run ${c.bold("grok login --device-auth")} on headless hosts first).`,
});
