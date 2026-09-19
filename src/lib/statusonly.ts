import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PoolPaths } from "./paths.ts";
import type { Provider, SampleReport } from "./provider.ts";
import { loadConfig, pinBinOverride, type Harvest } from "./state.ts";
import type { Account } from "./types.ts";
import { c } from "../cli/render.ts";

export type AuthEntry = { id: string; usable: boolean; harvest: Harvest | null };

export type StatusOnlySpec = {
  name: Provider["name"];
  flag: string;
  pool: PoolPaths;
  binName: string;
  binKey: "grokBin" | "opencodeBin";
  storeDirFor: (accountId: string) => string;
  authJsonFor: (accountId: string) => string;
  onboardDir: string;
  homeEnv: string;
  loginArgs: string[];
  onboardAuthRel: string;
  liveAuthPath: () => string;
  readAuth: (path: string) => AuthEntry[];
  liveId: () => string | null;
  versionOk: (versionOutput: string) => boolean;
  importIntro: string;
  foundLive: (count: number) => string;
  installNotice: string;
  loginStep: () => string;
};

export function statusOnlyProvider(spec: StatusOnlySpec): Provider {
  function resolveBin(): string {
    const configured = loadConfig()[spec.binKey];
    if (configured) {
      if (!existsSync(configured)) throw new Error(`configured ${spec.binKey} does not exist: ${configured} - fix config.json`);
      return configured;
    }
    for (const d of (process.env.PATH ?? "").split(":")) {
      if (!d) continue;
      const cand = join(d, spec.binName);
      try {
        if (existsSync(cand)) return cand;
      } catch {
        continue;
      }
    }
    throw new Error(`could not locate the real \`${spec.binName}\` binary (set ${spec.binKey} in config.json)`);
  }

  async function storeUsable(a: Account): Promise<boolean> {
    try {
      return spec.readAuth(spec.authJsonFor(a.id)).some((e) => e.id === a.id && e.usable);
    } catch {
      return false;
    }
  }

  async function samplePool(accounts: Account[]): Promise<Map<string, SampleReport>> {
    const reports = new Map<string, SampleReport>();
    for (const a of accounts) {
      reports.set(a.id, (await storeUsable(a)) ? { ok: true, source: "probe" } : { ok: false, reason: `no usable credential in this account's store - run \`tokenmaxxing auth${spec.flag}\`` });
    }
    return reports;
  }

  async function login(): Promise<Harvest | null> {
    const real = resolveBin();
    const onboardDir = spec.onboardDir;
    rmSync(onboardDir, { recursive: true, force: true });
    mkdirSync(onboardDir, { recursive: true });
    const p = Bun.spawn([real, ...spec.loginArgs], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, [spec.homeEnv]: onboardDir, TOKENMAXXING_PROBE: "1" },
    });
    await p.exited;
    try {
      const first = p.exitCode === 0 ? spec.readAuth(join(onboardDir, spec.onboardAuthRel))[0] : undefined;
      if (!first) {
        console.error(c.red(`no ${spec.name} login landed in the isolated home - nothing added.`));
        return null;
      }
      return first.harvest;
    } finally {
      rmSync(onboardDir, { recursive: true, force: true });
    }
  }

  async function importLive(): Promise<Harvest | null> {
    console.log(c.cyan(spec.importIntro));
    console.log();
    const live = spec.readAuth(spec.liveAuthPath());
    const first = live[0];
    if (first) {
      console.log(c.dim(spec.foundLive(live.length)));
      if (first.harvest) return first.harvest;
    }
    return login();
  }

  function preflight(): void {
    const real = resolveBin();
    const p = Bun.spawnSync([real, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    if (p.exitCode !== 0 || !spec.versionOk(p.stdout?.toString() ?? "")) {
      throw new Error(`${spec.binName} binary failed verification: ${real}`);
    }
    pinBinOverride({ key: spec.binKey, bin: real });
  }

  return {
    name: spec.name,
    flag: spec.flag,
    pool: spec.pool,
    seats: "live",
    waitsWhenDepleted: false,
    statusOnly: true,
    liveId: spec.liveId,
    presence: () => new Map(),
    gatedFamilies: () => null,
    observeLive: async (account) => (account.lastUsageAt != null ? { windows: account.windows, at: account.lastUsageAt } : null),
    samplePool,
    mergeWindows: (next) => next,
    swap: async () => {
      throw new Error(`${spec.name} moves are not supported yet (status-only pool)`);
    },
    classifySwapError: () => "fatal",
    removeCredentials: async (a) => {
      rmSync(spec.storeDirFor(a.id), { recursive: true, force: true });
    },
    storeUsable,
    login,
    importLive,
    preflight,
    install: () => {
      console.log(c.dim(spec.installNotice));
    },
    loginStep: spec.loginStep,
    windowLabel: (name) => name.toLowerCase(),
  };
}
