// The Slack->claude relay. One claude turn per Slack message via the Agent SDK
// (re-query with resume, never a persistent streaming query: the SDK subprocess
// reads credentials at spawn, so per-turn spawns are what let the pool decision
// pick the freshest account at every boundary and let the daemon restart
// without losing threads). Verified against @anthropic-ai/claude-agent-sdk
// 0.3.214 and code.claude.com/docs 2026-07-18; both change monthly.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { delay } from "es-toolkit";
import { createSdkMcpServer, query, tool, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { StreamChunk } from "chat";
import { ensureBestAccount, pooledOptions, stopHookCheck, type SwapDecision } from "../sdk.ts";
import { POST_SWAP_COOLDOWN_MS } from "./decide.ts";
import { readOAuthAccount } from "./claudejson.ts";
import { http, safeErrorDetail } from "./http.ts";
import { loadLastSwapAt } from "./state.ts";
import { fmtResetShort, recordObservedLimit } from "./usage.ts";
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
  /** the FAILED turn hit a usage/rate limit (or the pool was depleted before
   *  it could spawn). Only an errored result is ever limit-classified. */
  rateLimited: z.boolean(),
  /** the model called finish_thread this turn: garbage-collect after the turn. */
  finish: z.boolean(),
  /** relayThread posted a TERMINAL drop notice for this message ("dropped;
   *  re-send it"): a drain must NOT presume a killed child and retain the
   *  resume marker, or startup replays work the user was told to resend. */
  announcedDrop: z.boolean(),
  /** the LAST attempt's claude child ran to a SUCCESSFUL result: the work is
   *  done even if Slack delivery later failed (textLost sets failed for the
   *  operator's benefit). A drain must not read that delivery failure as a
   *  killed child and re-run completed work (adversarial-review catch). */
  resultReceived: z.boolean(),
});
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

// ---- depleted-pool recovery policy (pure, unit-tested) ---------------------

/** TOTAL parking budget for one Slack message (a single deadline across all
 *  its parks, not per park): the parked handler holds the thread's queue slot,
 *  so recovery further out gets an honest drop notice instead of a hostage
 *  handler, and the daemon's queue-entry TTL is sized to outlast a full
 *  park + turn so follow-ups fold instead of silently expiring. */
export const PARK_MAX_MS = 840_000;
/** spawn slightly after the reset passes, never right on the boundary. */
const PARK_GRACE_MS = 5_000;
/** post-limit short retry: one beat for the pool to observe the limit and
 *  swap (slaude's parkShortRetry - a successful swap makes it invisible). */
const RETRY_DELAY_MS = 10_000;
/** parks + retries per Slack message; keeps a stale usage cache from looping
 *  a thread forever. */
export const MAX_RECOVERIES = 3;

const ParkPlanSchema = z.union([
  z.object({ kind: z.literal("proceed") }),
  z.object({ kind: z.literal("park"), wakeAt: z.number() }),
  z.object({ kind: z.literal("drop"), recoversAt: z.number().nullable() }),
]);
export type ParkPlan = z.infer<typeof ParkPlanSchema>;

/** What to do with a spawn-boundary switch decision: proceed on a usable pool,
 *  park until the soonest recovery when it lands inside the message's one
 *  shared deadline, drop honestly otherwise (dropping beats a false
 *  will-resume promise - slaude's recorded rationale). The deadline is fixed
 *  when the message's relay starts, so chained parks can never hold the queue
 *  slot longer than PARK_MAX_MS in total. */
export function parkPlan(input: { decision: SwapDecision; recoveries: number; deadline: number }): ParkPlan {
  const depleted = input.decision.reason === "all-depleted" || input.decision.reason === "depleted-wait";
  if (!depleted) return { kind: "proceed" };
  const wake = input.decision.waitUntil ?? null;
  // the grace counts against the deadline too: the promised total hold is
  // exact, not deadline-plus-grace (review catch, PR #18).
  if (wake == null || wake + PARK_GRACE_MS > input.deadline || input.recoveries >= MAX_RECOVERIES) {
    return { kind: "drop", recoversAt: wake };
  }
  return { kind: "park", wakeAt: wake + PARK_GRACE_MS };
}

/** Phrases claude's ERRORED results carry at a usage/rate limit (ported from
 *  slaude's battle-tested set). Checked only against errored results: a
 *  successful answer that merely discusses usage limits (routine in this
 *  repo's own threads) must never be discarded and re-run. */
const RATE_LIMIT_PHRASES = [
  "usage limit reached",
  "rate limit reached",
  "rate limit exceeded",
  "rate limit hit",
  "hit your usage limit",
  "hit your weekly limit",
  "limit will reset",
  "5-hour limit",
  "out of extra usage",
];

export function isRateLimitText(input: { text: string }): boolean {
  const lower = input.text.toLowerCase();
  return RATE_LIMIT_PHRASES.some((phrase) => lower.includes(phrase));
}

/** The CLI puts an errored result's reason in `result` even on non-success
 *  subtypes (the exact shape PingResultSchema in usage.ts handles), while the
 *  SDK's error type declares only `errors` - so limit text is gathered
 *  loosely from both fields. */
const ResultTextSchema = z.looseObject({
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
});

function erroredResultText(message: unknown): string {
  const parsed = ResultTextSchema.safeParse(message);
  if (!parsed.success) return "";
  return [parsed.data.result, ...(parsed.data.errors ?? [])]
    .filter((t): t is string => t != null && t !== "")
    .join("\n");
}

// ---- workspace identity ----------------------------------------------------

const AuthTestSchema = z.looseObject({
  ok: z.boolean(),
  team_id: z.string().optional(),
  error: z.string().optional(),
});

/** auth.test: the home workspace (team) id the bot token belongs to - the
 *  reference `isOutsideAuthor` compares message origins against. Errors carry
 *  the Slack error code only, never the token. */
export async function fetchWorkspaceTeamId(input: { botToken: string }): Promise<string> {
  const res = await http
    .post("https://slack.com/api/auth.test", {
      headers: { authorization: `Bearer ${input.botToken}` },
    })
    .catch((e: unknown) => {
      // a thrown ky error (timeout, network) carries its Request with the
      // Authorization header - rethrow message-only so no caller can ever
      // log the token.
      throw new Error(`Slack auth.test failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  const text = await res.text();
  if (!res.ok) throw new Error(`Slack auth.test failed: HTTP ${res.status} (${safeErrorDetail({ text })})`);
  const body: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const parsed = AuthTestSchema.safeParse(body);
  if (!parsed.success || !parsed.data.ok || !parsed.data.team_id) {
    throw new Error(
      `Slack auth.test failed: ${parsed.success ? (parsed.data.error ?? "no team_id in response") : "unrecognized response"}`,
    );
  }
  return parsed.data.team_id;
}

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

/** Slack rejects an over-long message with msg_too_long, and NOTHING in chat
 *  4.34.0 or the Slack adapter bounds, truncates, or splits reply text
 *  (verified in-source 2026-07-20): a natively streamed message accumulates
 *  server-side toward the 12,000-char markdown_text envelope (docs.slack.dev
 *  documents that limit on chat.postMessage/update and all three streaming
 *  methods), the post-and-edit fallback re-sends the FULL accumulated text as
 *  markdown_text on every edit, and once anything rendered natively a failed
 *  append REJECTS the whole thread.post - the reply dies (live incident
 *  2026-07-20, three failed turns). relayThread therefore splits reply text
 *  across Slack messages BEFORE the cap; the 2,000-char margin absorbs the
 *  renderer's markdown normalization and mention-linkification expansion.
 *  Tradeoff (accepted): the adapter-internal plain-text fallback edits via
 *  chat.update `text` (hard 4,000-char cap), but it only engages when the
 *  workspace refused native streaming outright - splitting every normal reply
 *  3x tighter to cover that never-hit path is worse than the residual risk. */
export const SEGMENT_TEXT_MAX = 10_000;

/** Full permission name of the finish_thread tool (mcp__<server>__<tool>):
 *  it must be in allowedTools, because no one can answer a permission prompt
 *  through Slack. */
const FINISH_THREAD_TOOL = "mcp__tokenmaxxing__finish_thread";

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

const CleanupOutcomeSchema = z.object({
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

/** Live detached process-group leader pids: one process-exit hook SIGTERMs
 *  them all, so a forced daemon exit (second signal, drain timeout) cannot
 *  leak claude's tool subprocesses. */
const liveGroups = new Set<number>();
let groupExitHookArmed = false;

/** Exported for serve's orphan reaping: a daemon killed uncatchably (SIGKILL,
 *  crash) never runs the exit hook below, so the next generation must be able
 *  to terminate a surviving detached group before resuming its turn. */
export function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
  try {
    process.kill(-pid, signal);
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
 *
 * Depleted-pool recovery (ported from slaude at its shutdown, reshaped around
 * the pool): the spawn-boundary switch decision is CONSUMED, not discarded -
 * a depleted pool parks BEFORE a doomed spawn burns a failed turn, with an
 * honest in-thread notice either way; a mid-turn limit the cached pool state
 * did not predict is persisted (recordObservedLimit) and retried silently into
 * the same session. Total parking is bounded by one shared PARK_MAX_MS
 * deadline plus MAX_RECOVERIES, and every drop the relay itself performs is
 * announced in-thread (a queue-entry TTL expiry upstream is the one drop it
 * cannot see).
 */
export async function relayThread(input: {
  cwd: string;
  sessionId: string | null;
  prompt: string;
  /** bare Slack user id (U...) of the triggering message's author. */
  requesterIds: string[];
  link: SlackLink;
  post: (m: AsyncIterable<SegmentChunk>) => Promise<unknown>;
  /** fires the moment an init message assigns a session id the caller has not
   *  persisted yet, so a first-turn kill stays resumable (2026-07-18
   *  incident: a restart killed a first turn and the thread record kept
   *  sessionId null, stranding the session). Retries resume the same session,
   *  so re-fires only on an actual id change. */
  onSessionId?: (sessionId: string) => void;
  /** fires with the DETACHED claude child's pid (= its process-group id) the
   *  moment it spawns - once per spawn, so a retry's fresh child replaces the
   *  previous pid - so the caller can persist it into the activeTurn marker:
   *  a daemon death that skips the exit hook (SIGKILL, crash) leaves that
   *  group alive, and the next generation must find and reap it before
   *  resuming the turn. */
  onSpawn?: (pid: number) => void;
  /** daemon shutdown signal: aborts park/retry sleeps so a drain never sits
   *  out a depleted-pool countdown. */
  drainSignal?: AbortSignal;
}): Promise<TurnOutcome> {
  const outcome: TurnOutcome = { sessionId: input.sessionId, failed: false, rateLimited: false, finish: false, announcedDrop: false, resultReceived: false };
  let segment: ReturnType<typeof pushableStream> | null = null;
  let segmentMeta: { text: boolean; chars: number; fenceOpen: boolean } | null = null;
  let lastPost: Promise<unknown> = Promise.resolve();
  // Reply TEXT that was pushed into a rejected segment and never re-delivered
  // by a later text-bearing segment: the user has not seen the answer. A lost
  // card-only segment never sets this (decoration, not the answer).
  // Tradeoff (flagged and accepted): a later delivered text segment clears the
  // flag even though it is a continuation, because the dominant rejection is
  // Slack finalizing an idle stream - the streamed text WAS delivered, only
  // the append failed - and sticky loss would fail every long turn with a
  // spurious diagnostic; chat 4.34.0 exposes no per-chunk delivery acks to
  // tell that apart from a swallowed first post.
  let textLost = false;
  let textLostDetail: string | null = null;
  let postedText = false;
  const push = async (chunk: SegmentChunk) => {
    let seg = segment;
    if (!seg) {
      await lastPost; // strict message order: previous segment fully posted first
      seg = pushableStream();
      segment = seg;
      const posted = seg;
      const meta = { text: false, chars: 0, fenceOpen: false };
      segmentMeta = meta;
      lastPost = input.post(seg.iterable).then(
        () => {
          // segments settle in order (push awaits lastPost before opening the
          // next), so delivered text supersedes an earlier loss.
          if (meta.text) textLost = false;
        },
        (e: unknown) => {
          const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
          log("serve.post_error", { err: detail });
          if (meta.text) {
            textLost = true;
            textLostDetail = detail;
          }
          // the consumer is gone (e.g. Slack finalized an idle stream:
          // message_not_in_streaming_state) - drop the dead segment so the
          // next chunk opens a fresh message instead of vanishing into it.
          if (segment === posted) segment = null;
        },
      );
    }
    if (!(chunk instanceof Object)) {
      postedText = true;
      segmentMeta!.text = true;
      segmentMeta!.chars += chunk.length;
      // fence parity by occurrence count: an odd number of ``` markers in this
      // chunk flips whether the segment currently sits inside a code fence.
      if ((chunk.split("```").length - 1) % 2 === 1) segmentMeta!.fenceOpen = !segmentMeta!.fenceOpen;
    }
    seg.push(chunk);
  };
  const breakSegment = () => {
    segment?.end();
    segment = null;
  };
  /** Reply text routed through here splits across Slack messages before the
   *  msg_too_long cap (see SEGMENT_TEXT_MAX): a break prefers the last newline
   *  inside the remaining room, and a break forced inside a code fence closes
   *  it and reopens it in the next message so both halves render as code. */
  const pushText = async (text: string) => {
    for (let rest = text; rest !== "";) {
      const room = SEGMENT_TEXT_MAX - (segment === null ? 0 : segmentMeta!.chars);
      // a fence-close suffix can nudge a segment a few chars past the cap;
      // a full segment just breaks and the loop re-measures a fresh one.
      if (room <= 0) {
        breakSegment();
        continue;
      }
      if (rest.length <= room) {
        await push(rest);
        return;
      }
      // prefer a newline cut only when it lands in the back half of the room:
      // an early newline followed by one giant unbroken run would otherwise
      // make no progress and (with the fence-reopen prefix) loop forever.
      const nl = rest.lastIndexOf("\n", room - 1);
      const head = rest.slice(0, nl >= Math.floor(room / 2) ? nl + 1 : room);
      await push(head);
      const reopen = segmentMeta!.fenceOpen;
      if (reopen) await push("\n```");
      breakSegment();
      rest = (reopen ? "```\n" : "") + rest.slice(head.length);
    }
  };
  // a recovery status line reads as its own Slack message, not part of a
  // streamed segment.
  const notify = async (text: string) => {
    breakSegment();
    await push(text);
    breakSegment();
  };
  /** notify + confirm the post actually landed in Slack. A drop notice that
   *  never reached the user must NOT count as announced. DURING A DRAIN an
   *  unannounced drop keeps the resume marker so startup replays instead;
   *  outside a drain the marker is still cleared ON PURPOSE (closing-review
   *  catch corrected this doc, not the behavior): a non-drain drop happens
   *  after the turn's spawn decisions ran, and retaining its marker would
   *  make the next daemon restart RE-EXECUTE a possibly-metered turn whose
   *  outcome the user may already have seen - duplicate execution is worse
   *  than a lost message behind an already-broken Slack surface. The
   *  unannounced non-drain loss is logged loudly (serve.drop_unannounced) by
   *  the caller so it is at least operator-visible. The notice is text, so
   *  its own delivery resets textLost. */
  const notifyDelivered = async (text: string) => {
    await notify(text);
    await lastPost;
    return !textLost;
  };
  // false when the daemon started draining mid-sleep.
  const sleep = async (ms: number) => {
    try {
      await delay(Math.max(ms, 0), { signal: input.drainSignal });
      return true;
    } catch {
      return false;
    }
  };
  const inWord = (epochMs: number | null) => (epochMs == null ? "an unknown time" : `~${fmtResetShort(epochMs, Date.now()) || "1m"}`);

  const runQueryOnce = async () => {
    postedText = false;
    outcome.failed = false;
    outcome.rateLimited = false;
    outcome.resultReceived = false;
    // outcome.finish stays sticky across retries: the tool call already
    // happened in this session, and a limit right after it must not unfinish
    // the thread.
    // the identity this spawn meters: a limit observation is attributed to it,
    // never to whatever account a concurrent thread swaps live mid-turn. Read
    // inside the try: a malformed claude.json must fail the TURN, not the
    // relay's never-throws contract.
    let spawnOrg: string | null = null;
    try {
      spawnOrg = readOAuthAccount()?.organizationUuid ?? null;
      const pooled = pooledOptions();
      const q = query({
        prompt: input.prompt,
        options: {
          ...pooled,
          // claude >= 2.1.142 emits the structured Task tools by default and
          // TodoWrite (the source of the Todos checklist card) never fires;
          // this documented opt-out restores it (agent-sdk todo-tracking docs,
          // verified 2026-07-18 against SDK 0.3.214 + claude 2.1.214). Reuses
          // pooled.env so the scrubbed env copy is built once per turn (cubic
          // review catch on PR #5).
          env: { ...pooled.env, CLAUDE_CODE_ENABLE_TASKS: "0" },
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
          spawnClaudeCodeProcess: (spawnOptions) => {
            const child = detachedClaudeSpawn(spawnOptions);
            if (child.pid !== undefined) {
              try {
                input.onSpawn?.(child.pid);
              } catch (e) {
                // a failed marker persist must not leave an untracked group
                // running (cubic review catch): kill it, then fail the spawn
                // loudly through the SDK.
                killGroup(child.pid);
                throw e;
              }
            }
            return child;
          },
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
          // a retry resumes the session the failed attempt opened, so no
          // context is lost across recoveries.
          ...(outcome.sessionId ? { resume: outcome.sessionId } : {}),
        },
      });
      const mapState = newStreamMapState();
      let result: string | null = null;
      for await (const message of q) {
        if (message.type === "system" && message.subtype === "init") {
          // persist BEFORE the turn ends so a first-turn kill stays
          // resumable; compared against the last known id, so retry attempts
          // resuming the same session re-fire only on an actual change.
          if (message.session_id !== outcome.sessionId) input.onSessionId?.(message.session_id);
          outcome.sessionId = message.session_id;
        }
        if (message.type === "result") {
          outcome.sessionId = message.session_id;
          // is_error can ride a "success" subtype (a mid-turn usage limit
          // arrives exactly that way: result "Claude AI usage limit
          // reached|<epoch>"), so errored is a field check, not a subtype
          // check - and only an errored result is ever limit-classified.
          if (message.is_error || message.subtype !== "success") {
            const text = erroredResultText(message);
            outcome.failed = true;
            outcome.rateLimited = isRateLimitText({ text });
            // persist the observation: the retry's decision otherwise re-reads
            // the stale pre-limit snapshot (poll TTL) and respawns the same
            // depleted account - a serve process has no statusLine tee.
            if (outcome.rateLimited) await recordObservedLimit({ text, now: Date.now(), org: spawnOrg });
          } else {
            result = message.result;
            outcome.resultReceived = true;
          }
        }
        for (const part of agentEventChunks({ state: mapState, message })) {
          if (SegmentBreakSchema.safeParse(part).success) breakSegment();
          else {
            const chunk = SegmentChunkSchema.parse(part);
            if (chunk instanceof Object) await push(chunk);
            else await pushText(chunk);
          }
        }
      }
      // a turn that produced no streamed text (tool-only turns) still reports.
      if (!postedText && result) await pushText(result);
      if (!postedText && !result && outcome.failed && !outcome.rateLimited) {
        await push("the turn ended without a result - trying again may help");
      }
    } catch (e) {
      outcome.failed = true;
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      outcome.rateLimited = isRateLimitText({ text: detail });
      if (outcome.rateLimited) await recordObservedLimit({ text: detail, now: Date.now(), org: spawnOrg });
      log("serve.turn_error", { err: detail });
      if (!outcome.rateLimited) await push(`tokenmaxxing: turn failed: ${detail}`);
    }
  };

  let recoveries = 0;
  const parkDeadline = Date.now() + PARK_MAX_MS;
  while (true) {
    // the switch decision runs at the spawn boundary, same as the CLI hooks.
    let decision: SwapDecision;
    try {
      decision = await ensureBestAccount();
    } catch (e) {
      outcome.failed = true;
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      log("serve.turn_error", { err: detail });
      await push(`tokenmaxxing: turn failed: ${detail}`);
      break;
    }
    const plan = parkPlan({ decision, recoveries, deadline: parkDeadline });
    if (plan.kind === "drop") {
      outcome.failed = true;
      outcome.rateLimited = true;
      log("serve.pool_depleted_drop", { recoversAt: plan.recoversAt });
      outcome.announcedDrop = await notifyDelivered(`every pooled account is at its usage limit (recovers in ${inWord(plan.recoversAt)}) - this message was dropped; re-send it once the pool recovers.`);
      break;
    }
    if (plan.kind === "park") {
      recoveries += 1;
      log("serve.pool_depleted_park", { wakeAt: plan.wakeAt, recoveries });
      await notify(`every pooled account is at its usage limit - holding this message and retrying in ${inWord(plan.wakeAt)}.`);
      if (!(await sleep(plan.wakeAt - Date.now()))) {
        outcome.failed = true;
        outcome.announcedDrop = await notifyDelivered("tokenmaxxing is restarting - this message was dropped; please re-send it.");
        break;
      }
      continue;
    }
    await runQueryOnce();
    if (!outcome.failed || !outcome.rateLimited) break;
    if (recoveries >= MAX_RECOVERIES) {
      log("serve.rate_limited_drop", { recoveries });
      outcome.announcedDrop = await notifyDelivered("still at a usage limit after retries - this message was dropped; reply when you want to try again.");
      break;
    }
    // a limit the cached pool state did not predict: give the pool one beat
    // to observe it, then re-decide and retry the same prompt into the same
    // session (slaude's silent short retry - a successful swap makes it
    // invisible in the thread).
    recoveries += 1;
    breakSegment();
    log("serve.rate_limited_retry", { recoveries });
    // wait out an active post-swap cooldown too: a swap-then-instant-limit
    // would otherwise burn every retry inside the 45s window where the
    // decision refuses to re-evaluate, respawning the same limited account
    // (review catch, PR #18). The persisted observation then makes the
    // post-cooldown decision see the depleted account immediately.
    // loadLastSwapAt throws on a corrupt swap clock; every failure in this
    // loop must settle the turn in-thread (announced, never a bare throw),
    // same as the ensureBestAccount guard above (review catch, PR #31).
    let cooldownUntil: number;
    try {
      cooldownUntil = (loadLastSwapAt() ?? 0) + POST_SWAP_COOLDOWN_MS + 1_000;
    } catch (e) {
      outcome.failed = true;
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      log("serve.turn_error", { err: detail });
      await push(`tokenmaxxing: turn failed: ${detail}`);
      break;
    }
    if (!(await sleep(Math.max(RETRY_DELAY_MS, cooldownUntil - Date.now())))) {
      outcome.failed = true;
      outcome.announcedDrop = await notifyDelivered("tokenmaxxing is restarting - this message was dropped; please re-send it.");
      break;
    }
  }
  breakSegment();
  await lastPost;
  // Reply text died with a rejected segment and nothing later re-delivered it:
  // the answer silently vanished while the outcome would report success. Fail
  // the turn and make one best-effort fresh-message diagnostic (a fresh post
  // is exactly what the mid-stream recovery relies on succeeding).
  if (textLost) {
    outcome.failed = true;
    const detail = textLostDetail ?? "unknown error";
    await input
      .post((async function* () {
        yield `tokenmaxxing: the reply could not be posted to Slack: ${detail}`;
      })())
      .catch((e: unknown) => log("serve.post_error", { err: (e instanceof Error ? e.message : String(e)).slice(0, 300) }));
  }
  return outcome;
}
