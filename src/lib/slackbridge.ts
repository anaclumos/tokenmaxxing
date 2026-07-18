// The Slack->claude relay. One claude turn per Slack message via the Agent SDK
// (re-query with resume, never a persistent streaming query: the SDK subprocess
// reads credentials at spawn, so per-turn spawns are what let the pool decision
// pick the freshest account at every boundary and let the daemon restart
// without losing threads). Verified against @anthropic-ai/claude-agent-sdk
// 0.3.214 and code.claude.com/docs 2026-07-18; both change monthly.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { query, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
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

/** Live detached process-group leader pids: one process-exit hook SIGTERMs
 *  them all, so a forced daemon exit (second signal, drain timeout) cannot
 *  leak claude's tool subprocesses. */
const liveGroups = new Set<number>();
let groupExitHookArmed = false;

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (e) {
    // ESRCH = the group is already gone, which is the state we wanted;
    // anything else (EPERM, a bad pid) must surface, not silently leak.
    if (!(e instanceof Error && "code" in e && e.code === "ESRCH")) throw e;
  }
}

/**
 * Spawns the claude child in its OWN process group (post-0.19.1 review catch):
 * a terminal Ctrl-C delivers SIGINT to the whole foreground group, so a
 * non-detached child died at the same instant the daemon's drain started and
 * the drain could never preserve the in-flight turn. Detached, only the daemon
 * receives the terminal signal. Two consequences the review on PR #16 caught:
 * the SDK's SpawnedProcess contract consumes only stdin/stdout, so stderr must
 * be ignored outright (a piped-but-never-read stderr fills and blocks a chatty
 * child; exit errors lose the stderr tail, an accepted cost of turn survival),
 * and the SDK's abort path kills the lone PID, so the forwarded abort signal
 * and a process-exit hook SIGTERM the whole detached group instead - claude's
 * tool subprocesses must not outlive the daemon or the turn.
 */
export function detachedClaudeSpawn(options: SpawnOptions) {
  const stdio: ["pipe", "pipe", "ignore"] = ["pipe", "pipe", "ignore"];
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio,
    detached: true,
  });
  if (!groupExitHookArmed) {
    groupExitHookArmed = true;
    process.once("exit", () => {
      for (const pid of liveGroups) killGroup(pid);
    });
  }
  if (child.pid !== undefined) {
    const pid = child.pid;
    liveGroups.add(pid);
    const onAbort = () => killGroup(pid);
    // an already-aborted signal never fires "abort" again (cubic review
    // catch): a cancellation racing the spawn must still kill the group.
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("exit", () => {
      liveGroups.delete(pid);
      options.signal?.removeEventListener("abort", onAbort);
    });
  }
  return child;
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
        spawnClaudeCodeProcess: detachedClaudeSpawn,
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
