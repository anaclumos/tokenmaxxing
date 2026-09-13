import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { opencodeGoAuthJsonFor, opencodeGoPaths, opencodeGoPool, opencodeGoStoreDirFor } from "./paths.ts";
import type { Observation, Provider, SampleReport } from "./provider.ts";
import { loadConfig, pinBinOverride, type Harvest } from "./state.ts";
import type { Account } from "./types.ts";
import { c } from "../cli/render.ts";

const OpencodeAuthEntrySchema = z.looseObject({ type: z.string(), key: z.string().optional() });
const OpencodeAuthFileSchema = z.record(z.string(), z.unknown());

function dataHome(): string {
  return process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.length > 0 ? process.env.XDG_DATA_HOME : join(homedir(), ".local", "share");
}

function liveAuthPath(): string {
  return join(dataHome(), "opencode", "auth.json");
}

function parseAuthFile(path: string): { provider: string; key: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const map = OpencodeAuthFileSchema.safeParse(raw);
  if (!map.success) return null;
  const entry = OpencodeAuthEntrySchema.safeParse(map.data["opencode-go"]);
  if (!entry.success || entry.data.type !== "api" || !entry.data.key) return null;
  return { provider: "opencode-go", key: entry.data.key };
}

function idOfKey(key: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`opencode-go:${key}`);
  return `opencode-go-${h.digest("hex")}`;
}

function resolveRealOpencode(): string {
  const cfg = loadConfig();
  if (cfg.opencodeBin) {
    if (!existsSync(cfg.opencodeBin)) throw new Error(`configured opencodeBin does not exist: ${cfg.opencodeBin} - fix config.json`);
    return cfg.opencodeBin;
  }
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (!d) continue;
    const cand = join(d, "opencode");
    try {
      if (existsSync(cand)) return cand;
    } catch {
      continue;
    }
  }
  throw new Error("could not locate the real `opencode` binary (set opencodeBin in config.json)");
}

function liveId(): string | null {
  return null;
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
    reports.set(a.id, (await storeUsable(a)) ? { ok: true, source: "probe" } : { ok: false, reason: "no usable credential in this account's store - run `tokenmaxxing auth --opencode-go`" });
  }
  return reports;
}

async function storeUsable(a: Account): Promise<boolean> {
  try {
    const found = parseAuthFile(opencodeGoAuthJsonFor(a.id));
    return found != null && idOfKey(found.key) === a.id;
  } catch {
    return false;
  }
}

async function removeCredentials(a: Account): Promise<void> {
  rmSync(opencodeGoStoreDirFor(a.id), { recursive: true, force: true });
}

function harvestOf(key: string): Harvest {
  const id = idOfKey(key);
  return {
    id,
    email: null,
    tier: "go",
    sample: null,
    park: async () => {
      mkdirSync(opencodeGoStoreDirFor(id), { recursive: true });
      writeFileAtomic(opencodeGoAuthJsonFor(id), JSON.stringify({ "opencode-go": { type: "api", key } }, null, 2), 0o600);
    },
  };
}

async function login(): Promise<Harvest | null> {
  const real = resolveRealOpencode();
  const onboardDir = opencodeGoPaths.onboardDir;
  rmSync(onboardDir, { recursive: true, force: true });
  mkdirSync(onboardDir, { recursive: true });
  const p = Bun.spawn([real, "providers", "login", "-p", "opencode-go"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, XDG_DATA_HOME: onboardDir, TOKENMAXXING_PROBE: "1" },
  });
  await p.exited;
  try {
    if (p.exitCode !== 0) {
      console.error(c.red("no opencode-go login landed in the isolated home - nothing added."));
      return null;
    }
    const found = parseAuthFile(join(onboardDir, "opencode", "auth.json"));
    if (!found) {
      console.error(c.red("no opencode-go login landed in the isolated home - nothing added."));
      return null;
    }
    return harvestOf(found.key);
  } finally {
    rmSync(onboardDir, { recursive: true, force: true });
  }
}

async function importLive(): Promise<Harvest | null> {
  console.log(c.cyan("Pooling your opencode-go API key - your existing opencode auth stays as it is."));
  console.log();
  const found = parseAuthFile(liveAuthPath());
  if (found) {
    console.log(c.dim(`found an opencode-go credential in ${liveAuthPath()} - pooling it; use \`tokenmaxxing add --opencode-go\` for more keys.`));
    return harvestOf(found.key);
  }
  return login();
}

function preflight(): void {
  const real = resolveRealOpencode();
  const p = Bun.spawnSync([real, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  const out = (p.stdout?.toString() ?? "").trim();
  if (p.exitCode !== 0 || out === "") {
    throw new Error(`opencode binary failed verification: ${real}`);
  }
  pinBinOverride({ key: "opencodeBin", bin: real });
}

function install(): void {
  console.log(c.dim("opencode-go pool is status-only: no supervisor or hooks installed. Use `tokenmaxxing status` to view pooled keys."));
}

export const opencodeGo: Provider = {
  name: "opencode-go",
  flag: " --opencode-go",
  pool: opencodeGoPool,
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
    throw new Error("opencode-go moves are not supported yet (status-only pool)");
  },
  classifySwapError: () => "fatal",
  removeCredentials,
  storeUsable,
  login,
  importLive,
  preflight,
  install,
  loginStep: () => `Paste the opencode-go API key from ${c.bold("opencode.ai/zen")} when opencode asks for it.`,
  windowLabel: (name) => name.toLowerCase(),
};
