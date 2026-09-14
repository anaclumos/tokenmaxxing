import type { PoolPaths } from "./paths.ts";
import type { Harvest } from "./state.ts";
import type { Account, Config, Window } from "./types.ts";

export type Observation = { windows: Window[]; at: number };

export type SampleReport = { ok: true; source: "statusline" | "probe" } | { ok: false; reason: string };

export type SwapFailure = "dead-grant" | "skip" | "fatal";

export type Provider = {
  name: "claude" | "codex" | "grok" | "opencode-go";
  flag: string;
  pool: PoolPaths;
  seats: "shared" | "live";
  waitsWhenDepleted: boolean;
  statusOnly: boolean;
  liveId(): string | null;
  presence(): Map<string, number>;
  gatedFamilies(cfg: Config): string[] | null;
  observeLive(account: Account, cfg: Config, now: number, opts: { probe: boolean }): Promise<Observation | null>;
  samplePool(accounts: Account[], liveId: string | null, now: number): Promise<Map<string, SampleReport>>;
  mergeWindows(next: Window[], prev: Window[]): Window[];
  swap(target: Account): Promise<void>;
  classifySwapError(e: unknown): SwapFailure;
  removeCredentials(account: Account): Promise<void>;
  storeUsable(account: Account): Promise<boolean>;
  login(): Promise<Harvest | null>;
  importLive(): Promise<Harvest | null>;
  preflight(): void;
  install(): void;
  loginStep(who: string): string;
  windowLabel(name: string): string;
};
