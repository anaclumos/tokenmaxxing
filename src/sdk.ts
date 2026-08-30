import { z } from "zod";
import { UNMANAGED_ENV, resolveRealClaude } from "./lib/claudebin.ts";
import { evaluateAndMaybeSwap, type SwapDecision } from "./lib/decide.ts";
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

const AMBIENT_STORE_VARS = ["CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] as const;

export function pooledSpawnEnv(): Record<string, string> {
  for (const k of AMBIENT_STORE_VARS) {
    if (process.env[k]) {
      throw new Error(
        `${k} is set: the pooled SDK surface requires the default Claude Code credential store (a swap writes the live credential where ${k} points, while the spawned subprocess reads the default store). Unset it in the process running tokenmaxxing.`,
      );
    }
  }
  const env: Record<string, string> = { ...process.env, [UNMANAGED_ENV]: "1" };
  for (const k of CRED_ENV_OVERRIDES) delete env[k];
  return env;
}

const PooledOptionsSchema = z.object({
  pathToClaudeCodeExecutable: z.string(),
  env: z.record(z.string(), z.string()),
});
export type PooledOptions = z.infer<typeof PooledOptionsSchema>;

export function pooledOptions(): PooledOptions {
  return PooledOptionsSchema.parse({
    pathToClaudeCodeExecutable: claudeExecutablePath(),
    env: pooledSpawnEnv(),
  });
}

export async function stopHookCheck(): Promise<Record<string, never>> {
  try {
    await evaluateAndMaybeSwap(Date.now(), false);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error(`tokenmaxxing: switch check failed at turn boundary: ${err}`);
    log("sdk.stop_error", { err });
  }
  return {};
}
