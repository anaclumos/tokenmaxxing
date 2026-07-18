// The Slack->claude relay. One claude turn per Slack message via the Agent SDK
// (re-query with resume, never a persistent streaming query: the SDK subprocess
// reads credentials at spawn, so per-turn spawns are what let the pool decision
// pick the freshest account at every boundary and let the daemon restart
// without losing threads). Verified against @anthropic-ai/claude-agent-sdk
// 0.3.214 and code.claude.com/docs 2026-07-18; both change monthly.

import { join } from "node:path";
import { z } from "zod";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { StreamChunk } from "chat";
import { ensureBestAccount, pooledOptions, stopHookCheck } from "../sdk.ts";
import { deleteSlackThread, type SlackLink } from "./slackstate.ts";
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

/** The serve plugin shipped inside the package (src/serve-plugin/): skills
 *  that teach a relayed session how to behave in a Slack thread, loaded per
 *  turn via the SDK's local-plugin option and namespaced `tokenmaxxing:...`. */
const SERVE_PLUGIN_DIR = join(import.meta.dir, "..", "serve-plugin");

/**
 * The per-turn context a UserPromptSubmit hook injects. The skills are static
 * files, so the one dynamic fact they cannot carry - WHO asked - rides in
 * here as the requester's raw mention token (`<@U...>` passes verbatim
 * through the streamed markdown_text path, and the post-and-edit fallback's
 * finalize leaves an already-formed mention intact). Wording is load-bearing:
 * the ask-the-user skill points at the "Slack relay context" note.
 */
export function serveTurnContext(input: { requesterIds: string[] }): string {
  const tokens = input.requesterIds.map((id) => `<@${id}>`);
  let requester = "The requesting user is unknown this turn, so no mention token is available.";
  if (tokens.length === 1) requester = `The requesting user's Slack mention token is ${tokens[0]}; include it literally in reply text to notify them.`;
  if (tokens.length > 1) requester = `This turn folds messages from several users; their Slack mention tokens are ${tokens.join(" ")}. Include the relevant user's token literally in reply text to notify them.`;
  return [
    "Slack relay context: this session is relayed into a Slack thread by tokenmaxxing serve, and your reply posts back into the thread.",
    requester,
    "When you need the user's decision, approval, or input, follow the tokenmaxxing:ask-the-user skill (tag them, ask, end the turn).",
    "The tokenmaxxing:serve-session skill explains how this session runs.",
  ].join(" ");
}

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

/** Full permission name of the finish_thread tool (mcp__<server>__<tool>):
 *  it must be in allowedTools, because no one can answer a permission prompt
 *  through Slack. */
export const FINISH_THREAD_TOOL = "mcp__tokenmaxxing__finish_thread";

/** The per-turn in-process MCP server exposing finish_thread. The handler runs
 *  in the daemon process, but it must NOT delete anything inline: the claude
 *  subprocess is still mid-turn and segments are still streaming to Slack, so
 *  it only records the request and the daemon closes the thread after the
 *  turn ends (serve.ts). alwaysLoad keeps the tool visible in the prompt
 *  instead of deferred behind tool search: it has to be in view at the exact
 *  moment the user says the work is done. */
function finishToolServer(onFinish: () => void) {
  return createSdkMcpServer({
    name: "tokenmaxxing",
    alwaysLoad: true,
    tools: [
      tool(
        "finish_thread",
        "Close out this Slack thread when the user clearly states the work is finished (shipped, done, clean this up) and wants the thread closed. After this turn ends the daemon drops the thread's session record, unsubscribes, and posts a confirmation; the repo checkout and everything in it are untouched. Do not call this for a merely answered question - only for an explicit wrap-up.",
        {},
        async () => {
          onFinish();
          return { content: [{ type: "text", text: "close-out scheduled - it runs right after this turn ends and posts its own confirmation; just acknowledge the wrap-up now" }] };
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
 * Close out a finished thread. Threads run IN the linked repo checkout (no
 * per-thread worktree or branch since #14), so there is nothing on disk to
 * collect: dropping the slack-threads record is the whole cleanup, and the
 * shared checkout is never touched. The worktree-era residue gate and branch
 * archiving died with the worktrees themselves.
 */
export function cleanupThread(input: { threadId: string }): CleanupOutcome {
  deleteSlackThread(input.threadId);
  return { removed: true, message: "thread finished - session closed; a fresh @mention here starts a new one" };
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
  /** bare Slack user id (U...) of the triggering message's author. */
  requesterIds: string[];
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
        // the user saying "we're done" closes the thread: the model flags it
        // via this in-process tool, the daemon drops the record post-turn.
        mcpServers: { tokenmaxxing: finishToolServer(() => { outcome.finish = true; }) },
        allowedTools: [FINISH_THREAD_TOOL],
        // serve skills (ask-the-user, serve-session); discovered skills are
        // enabled by default, so no `skills` option is needed.
        plugins: [{ type: "local", path: SERVE_PLUGIN_DIR }],
        hooks: {
          UserPromptSubmit: [{
            hooks: [async () => ({
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: serveTurnContext({ requesterIds: input.requesterIds }),
              },
            })],
          }],
          Stop: [{ hooks: [stopHookCheck] }],
        },
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
