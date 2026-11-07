import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveRealBin, verifyRealBin } from "./claudebin.ts";
import { onboardHome } from "./onboard.ts";
import type { PoolPaths } from "./paths.ts";
import type { Provider } from "./provider.ts";
import { setConfigField, type Harvest } from "./state.ts";
import type { Account } from "./types.ts";
import { c } from "../cli/render.ts";

export type AuthEntry = { id: string; usable: boolean; harvest: Harvest | null };

type StatusOnlySpec = {
  name: Provider["name"];
  flag: string;
  pool: PoolPaths;
  bin: { name: string; key: "grokBin" | "museBin" | "cursorBin" | "kimiBin" | "vibeBin"; versionOk: (versionOutput: string) => boolean };
  storeDirFor: (accountId: string) => string;
  authJsonFor: (accountId: string) => string;
  homeEnv: string;
  loginArgs: () => string[];
  loginEnv?: Record<string, string | undefined>;
  onboardAuthRel: string;
  readAuth: (path: string) => AuthEntry[];
  liveId: () => string | null;
  presence: () => Map<string, number>;
  importIntro: string;
  live: { read: () => AuthEntry[]; found: (count: number) => string } | null;
  install: () => void;
  loginStep: () => string;
  samplePool: Provider["samplePool"];
  identify?: (harvest: Harvest) => Promise<void>;
};

export function statusOnlyProvider(spec: StatusOnlySpec): Provider {
  async function storeUsable(a: Account): Promise<boolean> {
    try {
      return spec.readAuth(spec.authJsonFor(a.id)).some((e) => e.id === a.id && e.usable);
    } catch {
      return false;
    }
  }

  async function login(): Promise<Harvest | null> {
    const real = resolveRealBin(spec.bin);
    const onboardDir = await onboardHome(spec.name);
    const p = Bun.spawn([real, ...spec.loginArgs()], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, ...spec.loginEnv, [spec.homeEnv]: onboardDir, TOKENMAXXING_PROBE: "1" },
    });
    await p.exited;
    try {
      const harvest = p.exitCode === 0 ? (spec.readAuth(join(onboardDir, spec.onboardAuthRel)).find((e) => e.harvest)?.harvest ?? null) : null;
      if (!harvest) console.error(c.red(`no ${spec.name} login landed in the isolated home - nothing added.`));
      else await spec.identify?.(harvest);
      return harvest;
    } finally {
      rmSync(onboardDir, { recursive: true, force: true });
    }
  }

  async function importLive(): Promise<Harvest | null> {
    console.log(c.cyan(spec.importIntro));
    console.log();
    if (spec.live == null) return login();
    const found = spec.live.read().filter((e) => e.harvest);
    const harvest = found[0]?.harvest;
    if (!harvest) return login();
    console.log(c.dim(spec.live.found(found.length)));
    await spec.identify?.(harvest);
    return harvest;
  }

  function preflight(): void {
    const real = resolveRealBin(spec.bin);
    const fail = verifyRealBin({ ...spec.bin, bin: real });
    if (fail !== null) throw new Error(`${spec.bin.name} binary failed verification: ${real}: ${fail}`);
    setConfigField(spec.bin.key, real);
  }

  return {
    name: spec.name,
    flag: spec.flag,
    pool: spec.pool,
    seats: "live",
    waitsWhenDepleted: false,
    statusOnly: true,
    liveId: spec.liveId,
    presence: spec.presence,
    gatedFamilies: () => null,
    heldFamilies: () => null,
    observeLive: async (account) => (account.lastUsageAt != null ? { windows: account.windows, at: account.lastUsageAt } : null),
    samplePool: spec.samplePool,
    mergeWindows: (next) => next,
    swap: async () => {
      throw new Error(`${spec.name} moves are not supported yet (status-only pool)`);
    },
    useBankedReset: async () => ({ reset: false, detail: `${spec.name} has no banked reset` }),
    classifySwapError: () => "fatal",
    removeCredentials: async (a) => {
      rmSync(spec.storeDirFor(a.id), { recursive: true, force: true });
    },
    storeUsable,
    login,
    importLive,
    preflight,
    install: spec.install,
    loginStep: spec.loginStep,
    windowLabel: (name) => name.toLowerCase(),
  };
}
