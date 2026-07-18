// The Slack->claude relay. One claude turn per Slack message via the Agent SDK
// (re-query with resume, never a persistent streaming query: the SDK subprocess
// reads credentials at spawn, so per-turn spawns are what let the pool decision
// pick the freshest account at every boundary and let the daemon restart
// without losing threads). Verified against @anthropic-ai/claude-agent-sdk
// 0.3.214 and code.claude.com/docs 2026-07-18; both change monthly.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { StreamChunk } from "chat";
import { ensureBestAccount, pooledOptions, stopHookCheck } from "../sdk.ts";
import { paths } from "./paths.ts";
import { deleteSlackThread, threadKey, type SlackLink } from "./slackstate.ts";
import { agentEventChunks, newStreamMapState, SegmentBreakSchema } from "./slackstream.ts";
import { log } from "./log.ts";

/** With systemPrompt omitted the SDK runs a MINIMAL system prompt (the
 *  claude_code preset is opt-in since SDK 0.1.0, re-verified for 0.3.214
 *  2026-07-18), so this small standalone prompt replaces nothing. It exists
 *  because a relayed model once answered with a literal "<br>": Slack renders
 *  markdown, never HTML. */
const SLACK_SYSTEM_PROMPT =
  "Your replies are relayed into a Slack thread and render as Slack-flavored markdown. Write plain markdown only - never HTML tags such as <br> (use real line breaks).";

export const TurnOutcomeSchema = z.object({
  sessionId: z.string().nullable(),
  failed: z.boolean(),
  /** the model called finish_thread this turn: garbage-collect after the turn. */
  finish: z.boolean(),
});
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

const SegmentChunkSchema = z.union([z.string(), z.custom<StreamChunk>()]);
type SegmentChunk = z.infer<typeof SegmentChunkSchema>;

/** A hand-pushed async iterable: relayThread feeds one of these per Slack
 *  message segment while thread.post concurrently drains it. */
function pushableStream(): {
  iterable: AsyncIterable<SegmentChunk>;
  push: (chunk: SegmentChunk) => void;
  end: () => void;
} {
  const queue: SegmentChunk[] = [];
  let done = false;
  let notify: (() => void) | null = null;
  return {
    push(chunk) {
      queue.push(chunk);
      notify?.();
    },
    end() {
      done = true;
      notify?.();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          for (let next = queue.shift(); next !== undefined; next = queue.shift()) yield next;
          if (done) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = null;
        }
      },
    },
  };
}

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
 * cwd-keyed. Worktrees are deleted only when the user finishes the thread
 * (finish_thread -> cleanupThread below) or by hand with `git worktree remove`.
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

/** Full permission name of the finish_thread tool (mcp__<server>__<tool>):
 *  it must be in allowedTools, because no one can answer a permission prompt
 *  through Slack. */
export const FINISH_THREAD_TOOL = "mcp__tokenmaxxing__finish_thread";

/** The per-turn in-process MCP server exposing finish_thread. The handler runs
 *  in the daemon process, but it must NOT delete anything inline: the claude
 *  subprocess is still mid-turn with its cwd inside the worktree and segments
 *  are still streaming to Slack, so it only records the request and the daemon
 *  garbage-collects after the turn ends (serve.ts). alwaysLoad keeps the tool
 *  visible in the prompt instead of deferred behind tool search: it has to be
 *  in view at the exact moment the user says the work is done. */
function finishToolServer(onFinish: () => void) {
  return createSdkMcpServer({
    name: "tokenmaxxing",
    alwaysLoad: true,
    tools: [
      tool(
        "finish_thread",
        "Wrap up this Slack thread when the user clearly states the work is finished (shipped, done, clean this up) and wants the thread closed out. After this turn ends the daemon removes the thread's git worktree and branch and drops its session record, then posts a confirmation. Uncommitted work is never discarded: a dirty worktree refuses the cleanup and the confirmation tells the user to commit or push first (or remove the worktree by hand). Do not call this for a merely answered question - only for an explicit wrap-up.",
        {},
        async () => {
          onFinish();
          return { content: [{ type: "text", text: "cleanup scheduled - it runs right after this turn ends and posts its own confirmation; just acknowledge the wrap-up now" }] };
        },
      ),
    ],
  });
}

export const CleanupOutcomeSchema = z.object({
  /** the thread's state is gone; a fresh @mention starts a new session. */
  removed: z.boolean(),
  message: z.string(),
});
export type CleanupOutcome = z.infer<typeof CleanupOutcomeSchema>;

/**
 * Garbage-collect a finished thread. The safety gates are git's own and are
 * never overridden: a dirty worktree refuses `git worktree remove` (the bot
 * NEVER discards uncommitted work - repo safeguard; the refusal tells the user
 * how to clean up by hand), and an unmerged branch refuses `git branch -d` and
 * is kept (the branch is a cheap pointer to real work; the worktree is the
 * disk hog, so its refusal aborts the whole cleanup while a kept branch does
 * not). In-place links only drop the thread record - the repo itself is never
 * touched. A refusal keeps the record and the subscription so the thread stays
 * live for a retry after the user commits.
 */
export function cleanupThread(input: { link: SlackLink; threadId: string; cwd: string }): CleanupOutcome {
  const notes: string[] = [];
  const key = threadKey(input.threadId);
  const worktreeDir = join(paths.slackWorktreesDir, key);
  if (input.link.worktree && input.cwd === worktreeDir) {
    const branch = `tm-slack-${key}`;
    if (existsSync(worktreeDir)) {
      try {
        git(input.link.repo, ["worktree", "remove", worktreeDir]);
        notes.push("worktree removed");
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return {
          removed: false,
          message: `not cleaned up (${detail}) - commit or push the work in ${worktreeDir} first, then say finish again; to discard it instead, remove the worktree by hand`,
        };
      }
    } else {
      // the dir was deleted by hand; prune the stale registration, else the
      // branch below still counts as checked out there.
      git(input.link.repo, ["worktree", "prune"]);
      notes.push("worktree was already gone");
    }
    try {
      git(input.link.repo, ["branch", "-d", branch]);
      notes.push(`branch ${branch} deleted`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      // the one expected refusal ("error: the branch 'x' is not fully merged",
      // capitalized on older gits); anything else is a real error and must not
      // be mislabeled as unmerged. The worktree is already gone by now, so the
      // cleanup still completes either way - the note carries the diagnosis.
      if (detail.toLowerCase().includes("not fully merged")) {
        notes.push(`branch ${branch} kept (unmerged - merge or delete it by hand)`);
      } else {
        notes.push(`branch ${branch} not deleted (${detail})`);
      }
    }
  }
  deleteSlackThread(input.threadId);
  notes.push("session closed - a fresh @mention here starts a new one");
  return { removed: true, message: `thread finished: ${notes.join("; ")}` };
}

/**
 * One claude turn relayed into a Slack thread as a SEQUENCE of messages: reply
 * text streams natively, thinking and tool calls stream as task_update cards
 * (see slackstream.ts), and a segment_break (a tool starting after streamed
 * text) closes the current Slack message and opens the next one, so a turn
 * reads as separate messages around its tool runs (user ask 2026-07-18).
 * Segments post strictly in order: the next opens only after the previous
 * post resolves. Never throws: a failure posts a short diagnostic line and
 * sets outcome.failed (the daemon must keep serving other threads). Error
 * text is message-only - a raw error body could echo request material.
 */
export async function relayThread(input: {
  cwd: string;
  sessionId: string | null;
  prompt: string;
  link: SlackLink;
  post: (m: AsyncIterable<SegmentChunk>) => Promise<unknown>;
}): Promise<TurnOutcome> {
  const outcome: TurnOutcome = { sessionId: input.sessionId, failed: false, finish: false };
  let segment: ReturnType<typeof pushableStream> | null = null;
  let lastPost: Promise<unknown> = Promise.resolve();
  let postedText = false;
  const push = async (chunk: SegmentChunk) => {
    let seg = segment;
    if (!seg) {
      await lastPost; // strict message order: previous segment fully posted first
      seg = pushableStream();
      segment = seg;
      const posted = seg;
      lastPost = input.post(seg.iterable).catch((e: unknown) => {
        const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        log("serve.post_error", { err: detail });
        // the consumer is gone (e.g. Slack finalized an idle stream:
        // message_not_in_streaming_state) - drop the dead segment so the
        // next chunk opens a fresh message instead of vanishing into it.
        if (segment === posted) segment = null;
      });
    }
    if (!postedText && !(chunk instanceof Object)) postedText = true;
    seg.push(chunk);
  };
  const breakSegment = () => {
    segment?.end();
    segment = null;
  };
  try {
    // the switch decision runs at the spawn boundary, same as the CLI hooks.
    await ensureBestAccount();
    const q = query({
      prompt: input.prompt,
      options: {
        ...pooledOptions(),
        cwd: input.cwd,
        permissionMode: input.link.permissionMode,
        // the SDK refuses bypassPermissions without this explicit opt-in.
        ...(input.link.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        includePartialMessages: true,
        systemPrompt: SLACK_SYSTEM_PROMPT,
        // no one can answer an interactive question dialog through Slack;
        // without the tool the model asks in prose and the user's thread
        // reply becomes the next turn.
        disallowedTools: ["AskUserQuestion"],
        // the user saying "we're done" garbage-collects the thread: the model
        // flags it via this in-process tool, the daemon cleans up post-turn.
        mcpServers: { tokenmaxxing: finishToolServer(() => { outcome.finish = true; }) },
        allowedTools: [FINISH_THREAD_TOOL],
        hooks: { Stop: [{ hooks: [stopHookCheck] }] },
        ...(input.link.model ? { model: input.link.model } : {}),
        ...(input.sessionId ? { resume: input.sessionId } : {}),
      },
    });
    const mapState = newStreamMapState();
    let result: string | null = null;
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") outcome.sessionId = message.session_id;
      if (message.type === "result") {
        outcome.sessionId = message.session_id;
        if (message.subtype === "success") result = message.result;
        else outcome.failed = true;
      }
      for (const part of agentEventChunks({ state: mapState, message })) {
        if (SegmentBreakSchema.safeParse(part).success) breakSegment();
        else await push(SegmentChunkSchema.parse(part));
      }
    }
    // a turn that produced no streamed text (tool-only turns) still reports.
    if (!postedText && result) await push(result);
    if (!postedText && !result && outcome.failed) await push("the turn ended without a result (limit or error) - trying again may help");
  } catch (e) {
    outcome.failed = true;
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    log("serve.turn_error", { err: detail });
    await push(`tokenmaxxing: turn failed: ${detail}`);
  }
  breakSegment();
  await lastPost;
  return outcome;
}
