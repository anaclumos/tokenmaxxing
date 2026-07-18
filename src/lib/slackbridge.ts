// The Slack->claude relay. One claude turn per Slack message via the Agent SDK
// (re-query with resume, never a persistent streaming query: the SDK subprocess
// reads credentials at spawn, so per-turn spawns are what let the pool decision
// pick the freshest account at every boundary and let the daemon restart
// without losing threads). Verified against @anthropic-ai/claude-agent-sdk
// 0.3.214 and code.claude.com/docs 2026-07-18; both change monthly.

import { z } from "zod";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { StreamChunk } from "chat";
import { ensureBestAccount, pooledOptions, stopHookCheck } from "../sdk.ts";
import type { SlackLink } from "./slackstate.ts";
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
  /** fires the moment the init message assigns a session id, so the caller can
   *  persist it BEFORE the turn ends - a first-turn kill must stay resumable
   *  (2026-07-18 incident: a restart killed a first turn and the thread record
   *  kept sessionId null, stranding the session). */
  onSessionId?: (sessionId: string) => void;
}): Promise<TurnOutcome> {
  const outcome: TurnOutcome = { sessionId: input.sessionId, failed: false };
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
        hooks: { Stop: [{ hooks: [stopHookCheck] }] },
        ...(input.link.model ? { model: input.link.model } : {}),
        ...(input.sessionId ? { resume: input.sessionId } : {}),
      },
    });
    const mapState = newStreamMapState();
    let result: string | null = null;
    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        outcome.sessionId = message.session_id;
        if (message.session_id !== input.sessionId) input.onSessionId?.(message.session_id);
      }
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
