import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveRealBin, verifyRealBin } from "./claudebin.ts";
import { onboardHome } from "./onboard.ts";
import type { PoolPaths } from "./paths.ts";
import type { Provider } from "./provider.ts";
import { pinBinOverride, type Harvest } from "./state.ts";
import type { Account } from "./types.ts";
import { c } from "../cli/render.ts";

export type AuthEntry = { id: string; usable: boolean; harvest: Harvest | null };

export type StatusOnlySpec = {
  name: Provider["name"];
  flag: string;
  pool: PoolPaths;
  binName: string;
  binKey: "grokBin" | "museBin";
  storeDirFor: (accountId: string) => string;
  authJsonFor: (accountId: string) => string;
  homeEnv: string;
  loginArgs: string[];
  onboardAuthRel: string;
  liveAuthPath: () => string;
  readAuth: (path: string) => AuthEntry[];
  liveId: () => string | null;
  presence: () => Map<string, number>;
  versionOk: (versionOutput: string) => boolean;
  importIntro: string;
  foundLive: (count: number) => string;
  installNotice: string;
  loginStep: () => string;
  samplePool: Provider["samplePool"];
};

export function statusOnlyProvider(spec: StatusOnlySpec): Provider {
  const bin = { name: spec.binName, key: spec.binKey, versionOk: spec.versionOk };

  async function storeUsable(a: Account): Promise<boolean> {
    try {
      return spec.readAuth(spec.authJsonFor(a.id)).some((e) => e.id === a.id && e.usable);
    } catch {
      return false;
    }
  }

  async function login(): Promise<Harvest | null> {
    const real = resolveRealBin(bin);
    const onboardDir = await onboardHome(spec.name);
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
    const real = resolveRealBin(bin);
    const fail = verifyRealBin({ ...bin, bin: real });
    if (fail !== null) throw new Error(`${spec.binName} binary failed verification: ${real}: ${fail}`);
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
    presence: spec.presence,
    gatedFamilies: () => null,
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
    install: () => {
      console.log(c.dim(spec.installNotice));
    },
    loginStep: spec.loginStep,
    windowLabel: (name) => name.toLowerCase(),
  };
}
