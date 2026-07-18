// The Slack->claude relay. One claude turn per Slack message via the Agent SDK
// (re-query with resume, never a persistent streaming query: the SDK subprocess
// reads credentials at spawn, so per-turn spawns are what let the pool decision
// pick the freshest account at every boundary and let the daemon restart
// without losing threads). Verified against @anthropic-ai/claude-agent-sdk
// 0.3.214 and code.claude.com/docs 2026-07-18; both change monthly.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ensureBestAccount, pooledOptions, stopHookCheck } from "../sdk.ts";
import { paths } from "./paths.ts";
import { threadKey, type SlackLink } from "./slackstate.ts";
import { log } from "./log.ts";

/** Mutated in place by relayTurn so the caller can hand the generator straight
 *  to thread.post(AsyncIterable) and still read the turn's outcome afterward. */
export const TurnOutcomeSchema = z.object({
  sessionId: z.string().nullable(),
  failed: z.boolean(),
});
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

/** Run one git command against a repo; throws with trimmed stderr on failure. */
function git(repo: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const stderr = new TextDecoder().decode(r.stderr).trim();
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.slice(0, 200)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

/**
 * The stable cwd a thread's turns run in. Worktree mode (default) creates
 * `slack-worktrees/<threadKey>` on branch `tm-slack-<threadKey>` cut from the
 * repo's current HEAD, once; both survive daemon restarts because resume is
 * cwd-keyed. Worktrees are never auto-deleted (they hold the thread's work):
 * clean up with `git worktree remove` when done.
 */
export function ensureThreadCwd(input: { link: SlackLink; threadId: string }): string {
  if (!input.link.worktree) return input.link.repo;
  const key = threadKey(input.threadId);
  const dir = join(paths.slackWorktreesDir, key);
  if (existsSync(dir)) return dir;
  mkdirSync(paths.slackWorktreesDir, { recursive: true });
  const branch = `tm-slack-${key}`;
  const branchExists = Bun.spawnSync(["git", "-C", input.link.repo, "rev-parse", "--verify", "--quiet", branch]).exitCode === 0;
  // a crash between branch creation and worktree add leaves the branch behind;
  // reattach instead of failing on -b collision.
  if (branchExists) git(input.link.repo, ["worktree", "add", dir, branch]);
  else git(input.link.repo, ["worktree", "add", dir, "-b", branch]);
  log("serve.worktree_created", { dir, branch });
  return dir;
}

/**
 * One claude turn, yielded as streaming text deltas (feed directly to
 * thread.post). Never throws: a failure yields a short diagnostic line and
 * sets outcome.failed (the daemon must keep serving other threads). Error
 * text is message-only - a raw error body could echo request material.
 */
export async function* relayTurn(
  input: { cwd: string; sessionId: string | null; prompt: string; link: SlackLink },
  outcome: TurnOutcome,
): AsyncGenerator<string> {
  let yieldedAny = false;
  try {
    // the switch decision runs at the spawn boundary, same as the CLI hooks.
    await ensureBestAccount();
    const q = query({
      prompt: input.prompt,
      options: {
        ...pooledOptions(),
        cwd: input.cwd,
        permissionMode: input.link.permissionMode,
        includePartialMessages: true,
        hooks: { Stop: [{ hooks: [stopHookCheck] }] },
        ...(input.link.model ? { model: input.link.model } : {}),
        ...(input.sessionId ? { resume: input.sessionId } : {}),
      },
    });
    let result: string | null = null;
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") outcome.sessionId = message.session_id;
      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yieldedAny = true;
          yield event.delta.text;
        }
      }
      if (message.type === "result") {
        outcome.sessionId = message.session_id;
        if (message.subtype === "success") result = message.result;
        else outcome.failed = true;
      }
    }
    // a turn that produced no streamed text (tool-only turns) still reports.
    if (!yieldedAny && result) yield result;
    if (!yieldedAny && !result && outcome.failed) yield "the turn ended without a result (limit or error) - trying again may help";
  } catch (e) {
    outcome.failed = true;
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    log("serve.turn_error", { err: detail });
    yield `${yieldedAny ? "\n\n" : ""}tokenmaxxing: turn failed: ${detail}`;
  }
}
