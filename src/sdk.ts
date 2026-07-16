// Programmatic surface for pairing tokenmaxxing with the Claude Code Agent SDK
// (personal use across your own pooled accounts - user decision 2026-07-16).
//
// The Agent SDK spawns a claude CLI subprocess per query() and that subprocess
// reads credentials at spawn time: no statusLine tee, no supervisor, no
// mid-query hot-swap. So the integration is boundary-driven - run the switch
// decision BEFORE a spawn so it lands on the best account, and again at
// Stop-hook turn boundaries so the NEXT spawn does; a running subprocess keeps
// its snapshotted token either way, which is exactly the clean-boundary
// semantics the CLI supervisor enforces with markers.
//
// Nothing here imports the Agent SDK: the helpers return plain values that
// spread structurally into its Options, so tokenmaxxing keeps its exact
// dependency set (zod, es-toolkit, ky).

import { z } from "zod";
import { MAX_WRAP_DEPTH, WRAP_DEPTH_ENV, resolveRealClaude } from "./lib/claudebin.ts";
import { evaluateAndMaybeSwap, type SwapDecision } from "./lib/decide.ts";
import { CRED_ENV_OVERRIDES } from "./lib/usage.ts";
import { log } from "./lib/log.ts";

export { evaluateAndMaybeSwap };
export type { SwapDecision };

/**
 * Run the same greedy pace-pressure decision the hooks and check timer run
 * (never anticipatory: there is no supervisor to pause an SDK session, so a
 * depleted pre-park would yank it onto a known-blocked account for nothing).
 * Call it right before query() so the subprocess spawns on the best account.
 */
export async function ensureBestAccount(now = Date.now()): Promise<SwapDecision> {
  return evaluateAndMaybeSwap(now, false);
}

/** The pinned real claude binary, for Options.pathToClaudeCodeExecutable.
 *  Never the supervisor wrapper: an SDK subprocess is headless print mode, so
 *  the wrapper's respawn machinery buys nothing and only adds recursion risk. */
export function claudeExecutablePath(): string {
  return resolveRealClaude();
}

/** The pooled surface requires the DEFAULT Claude Code credential store. An
 *  ambient config-dir override desyncs the two sides of a swap on Linux: the
 *  swap (running in THIS process) writes the live credential where these vars
 *  point (credDir() honors them), while the scrubbed subprocess reads the
 *  default store - so the subprocess silently runs on a stale or absent
 *  credential. Fail fast on both platforms rather than platform-split the
 *  behavior (adversarial review catch, 2026-07-16). */
const AMBIENT_STORE_VARS = ["CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] as const;

/**
 * The env an SDK-spawned claude must run under to meter the POOLED live
 * credential: every ambient credential override is scrubbed (claude honors
 * them BEFORE its keychain/file lookup, so one inherited ANTHROPIC_API_KEY
 * silently meters the wrong account), and the wrap depth is preset to the cap
 * so a poisoned claudeBin pin that leads back into the tokenmaxxing wrapper
 * aborts on first entry instead of fork-bombing.
 *
 * Returns a FULL environment, not a patch: the Agent SDK's Options.env
 * REPLACES the subprocess env rather than merging over process.env (verified
 * against the official TS reference 2026-07-16), which is what makes deleting
 * keys from this copy effective.
 */
export function pooledSpawnEnv(): Record<string, string> {
  for (const k of AMBIENT_STORE_VARS) {
    if (process.env[k]) {
      throw new Error(
        `${k} is set: the pooled SDK surface requires the default Claude Code credential store (a swap writes the live credential where ${k} points, while the spawned subprocess reads the default store). Unset it in the process running tokenmaxxing.`,
      );
    }
  }
  const env: Record<string, string> = { ...process.env, [WRAP_DEPTH_ENV]: String(MAX_WRAP_DEPTH) };
  for (const k of CRED_ENV_OVERRIDES) delete env[k];
  return env;
}

const PooledOptionsSchema = z.object({
  pathToClaudeCodeExecutable: z.string(),
  env: z.record(z.string(), z.string()),
});
export type PooledOptions = z.infer<typeof PooledOptionsSchema>;

/** Options fragment to spread into the Agent SDK's Options. */
export function pooledOptions(): PooledOptions {
  return PooledOptionsSchema.parse({
    pathToClaudeCodeExecutable: claudeExecutablePath(),
    env: pooledSpawnEnv(),
  });
}

/**
 * Agent SDK Stop-hook callback (structurally matches HookCallback; the args
 * are irrelevant here; `{}` is the documented no-op output). Runs the switch
 * decision at the turn boundary; a swap landed here takes effect on the next
 * subprocess spawn. Errors are caught LOUDLY (stderr + log), not rethrown:
 * the SDK hooks reference states an unhandled exception can interrupt the
 * agent (verified 2026-07-16), and aborting the caller's turn because a
 * switch check failed costs more than riding out the current account. Call
 * ensureBestAccount() directly where a broken pool should throw.
 */
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
