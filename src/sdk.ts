import { UNMANAGED_ENV, resolveRealClaude } from "./lib/claudebin.ts";
import { evaluateAndMaybeSwap, type SwapDecision } from "./lib/decide.ts";
import { errorMessage } from "./lib/errors.ts";
import { ambientStoreDir } from "./lib/paths.ts";
import { CRED_ENV_OVERRIDES } from "./lib/usage.ts";
import { log } from "./lib/log.ts";

export { evaluateAndMaybeSwap };
export type { SwapDecision };

export async function ensureBestAccount(now = Date.now()): Promise<SwapDecision> {
  return evaluateAndMaybeSwap(now, false);
}

export function claudeExecutablePath(): string {
  return resolveRealClaude();
}

export function pooledSpawnEnv(): Record<string, string> {
  const ambient = ambientStoreDir();
  if (ambient != null) {
    throw new Error(
      `${ambient.name} is set: the pooled SDK surface requires the default Claude Code credential store (a swap writes the live credential where ${ambient.name} points, while the spawned subprocess reads the default store). Unset it in the process running tokenmaxxing.`,
    );
  }
  const env: Record<string, string> = { ...process.env, [UNMANAGED_ENV]: "1" };
  for (const k of CRED_ENV_OVERRIDES) delete env[k];
  return env;
}

export type PooledOptions = {
  pathToClaudeCodeExecutable: string;
  env: Record<string, string>;
};

export function pooledOptions(): PooledOptions {
  return { pathToClaudeCodeExecutable: claudeExecutablePath(), env: pooledSpawnEnv() };
}

export async function stopHookCheck(): Promise<Record<string, never>> {
  try {
    await evaluateAndMaybeSwap(Date.now(), false);
  } catch (e) {
    const err = errorMessage(e);
    console.error(`tokenmaxxing: switch check failed at turn boundary: ${err}`);
    log("sdk.stop_error", { err });
  }
  return {};
}
