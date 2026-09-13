import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { grokAuthJsonFor, grokPaths, grokPool, grokSeatFromEnv, grokStoreDirFor } from "./paths.ts";
import type { Observation, Provider, SampleReport } from "./provider.ts";
import { loadAccounts, loadConfig, pinBinOverride, type Harvest } from "./state.ts";
import type { Account } from "./types.ts";
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

function parseGrokAuthFile(path: string): { key: string; entry: GrokAuthEntry }[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const map = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!map.success) return [];
  const out: { key: string; entry: GrokAuthEntry }[] = [];
  for (const [key, value] of Object.entries(map.data)) {
    const parsed = GrokAuthEntrySchema.safeParse(value);
    if (parsed.success) out.push({ key, entry: parsed.data });
  }
  return out;
}

function identityOf(key: string, entry: GrokAuthEntry): { id: string; email: string | null } {
  const id = entry.user_id ?? entry.principal_id ?? key;
  return { id, email: entry.email ?? null };
}

function resolveRealGrok(): string {
  const cfg = loadConfig();
  if (cfg.grokBin) {
    if (!existsSync(cfg.grokBin)) throw new Error(`configured grokBin does not exist: ${cfg.grokBin} - fix config.json`);
    return cfg.grokBin;
  }
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (!d) continue;
    const cand = join(d, "grok");
    try {
      if (existsSync(cand)) return cand;
    } catch {
      continue;
    }
  }
  throw new Error("could not locate the real `grok` binary (set grokBin in config.json)");
}

function liveId(): string | null {
  return grokSeatFromEnv(loadAccounts(grokPool).accounts.map((a) => a.id));
}

function presence(): Map<string, number> {
  return new Map();
}

async function observeLive(account: Account): Promise<Observation | null> {
  return account.lastUsageAt != null ? { windows: account.windows, at: account.lastUsageAt } : null;
}

async function samplePool(accounts: Account[]): Promise<Map<string, SampleReport>> {
  const reports = new Map<string, SampleReport>();
  for (const a of accounts) {
    reports.set(a.id, (await storeUsable(a)) ? { ok: true, source: "probe" } : { ok: false, reason: "no usable credential in this account's store - run `tokenmaxxing auth --grok`" });
  }
  return reports;
}

async function storeUsable(a: Account): Promise<boolean> {
  try {
    const entries = parseGrokAuthFile(grokAuthJsonFor(a.id));
    return entries.some((e) => identityOf(e.key, e.entry).id === a.id && (e.entry.refresh_token ?? "") !== "");
  } catch {
    return false;
  }
}

async function removeCredentials(a: Account): Promise<void> {
  rmSync(grokStoreDirFor(a.id), { recursive: true, force: true });
}

function harvestOf(key: string, entry: GrokAuthEntry): Harvest | null {
  const { id, email } = identityOf(key, entry);
  if (!id) return null;
  return {
    id,
    email,
    tier: null,
    sample: null,
    park: async () => {
      mkdirSync(grokStoreDirFor(id), { recursive: true });
      writeFileAtomic(grokAuthJsonFor(id), JSON.stringify({ [key]: entry }, null, 2), 0o600);
    },
  };
}

async function login(): Promise<Harvest | null> {
  const real = resolveRealGrok();
  const onboardDir = grokPaths.onboardDir;
  rmSync(onboardDir, { recursive: true, force: true });
  mkdirSync(onboardDir, { recursive: true });
  const p = Bun.spawn([real, "login"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, GROK_HOME: onboardDir, TOKENMAXXING_PROBE: "1" },
  });
  await p.exited;
  try {
    if (p.exitCode !== 0) {
      console.error(c.red("no grok login landed in the isolated home - nothing added."));
      return null;
    }
    const entries = parseGrokAuthFile(join(onboardDir, "auth.json"));
    if (entries.length === 0) {
      console.error(c.red("no grok login landed in the isolated home - nothing added."));
      return null;
    }
    return harvestOf(entries[0]!.key, entries[0]!.entry);
  } finally {
    rmSync(onboardDir, { recursive: true, force: true });
  }
}

async function importLive(): Promise<Harvest | null> {
  console.log(c.cyan("Opening an isolated grok login for your first pooled account - the login you already have stays as it is."));
  console.log();
  const live = parseGrokAuthFile(join(grokPaths.home, "auth.json"));
  if (live.length > 0) {
    console.log(c.dim(`found ${live.length} grok login(s) in ${grokPaths.home} - pooling the first; use \`tokenmaxxing add --grok\` for the rest.`));
    const h = harvestOf(live[0]!.key, live[0]!.entry);
    if (h) return h;
  }
  return login();
}

function preflight(): void {
  const real = resolveRealGrok();
  const p = Bun.spawnSync([real, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  const out = (p.stdout?.toString() ?? "").trim().toLowerCase();
  if (p.exitCode !== 0 || !out.includes("grok")) {
    throw new Error(`grok binary failed verification: ${real}`);
  }
  pinBinOverride({ key: "grokBin", bin: real });
}

function install(): void {
  console.log(c.dim("grok pool is status-only: no supervisor or hooks installed. Use `tokenmaxxing status` to view pooled grok accounts."));
}

export const grok: Provider = {
  name: "grok",
  flag: " --grok",
  pool: grokPool,
  seats: "live",
  waitsWhenDepleted: false,
  statusOnly: true,
  liveId,
  presence,
  gatedFamilies: () => null,
  observeLive,
  samplePool,
  mergeWindows: (next) => next,
  swap: async () => {
    throw new Error("grok moves are not supported yet (status-only pool)");
  },
  classifySwapError: () => "fatal",
  removeCredentials,
  storeUsable,
  login,
  importLive,
  preflight,
  install,
  loginStep: () => `Sign in in the browser session that opens (or run ${c.bold("grok login --device-auth")} on headless hosts first).`,
  windowLabel: (name) => name.toLowerCase(),
};
