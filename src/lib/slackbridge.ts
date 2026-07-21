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
import { StreamingMarkdownRenderer, type StreamChunk } from "chat";
import { ensureBestAccount, pooledOptions, stopHookCheck, type SwapDecision } from "../sdk.ts";
import { POST_SWAP_COOLDOWN_MS } from "./decide.ts";
import { readOAuthAccount } from "./claudejson.ts";
import { http, safeErrorDetail } from "./http.ts";
import { loadLastSwapAt } from "./state.ts";
import { fmtResetShort, recordObservedLimit } from "./usage.ts";
import { deleteSlackThread, type SlackLink } from "./slackstate.ts";
import { agentEventChunks, newStreamMapState } from "./slackstream.ts";
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
  /** the model called need_attention this turn (it asked the user for a
   *  decision): the daemon marks the thread waiting - question-mark status
   *  reaction, a one-time nudge if the user stays quiet, and an asked user's
   *  reaction relays as their answer. */
  attention: z.boolean(),
  /** relayThread posted a TERMINAL drop notice for this message ("dropped;
   *  re-send it"): a drain must NOT presume a killed child and retain the
   *  resume marker, or startup replays work the user was told to resend. */
  announcedDrop: z.boolean(),
  /** the LAST attempt's claude child ran to a SUCCESSFUL result: the work is
   *  done even if Slack delivery later failed (textLost sets failed for the
   *  operator's benefit). A drain must not read that delivery failure as a
   *  killed child and re-run completed work (adversarial-review catch). */
  resultReceived: z.boolean(),
  /** epoch ms when the pool is expected usable again: set when the turn ended
   *  at a usage limit whose recovery time is known. The caller keeps the
   *  thread's activeTurn marker with resumeAt and the daemon resumes the turn
   *  itself, instead of the old "re-send it once the pool recovers" drop. */
  deferUntil: z.number().nullable(),
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
  z.object({ kind: z.literal("defer"), resumeAt: z.number() }),
  z.object({ kind: z.literal("drop") }),
]);
export type ParkPlan = z.infer<typeof ParkPlanSchema>;

/** What to do with a spawn-boundary switch decision: proceed on a usable pool;
 *  park in-handler until the soonest recovery when it lands inside the
 *  message's one shared deadline; DEFER when recovery is known but further
 *  out (or the in-handler recovery budget is spent): the handler releases the
 *  queue slot and the daemon resumes the turn from its durable marker once
 *  the pool recovers (2026-07-20 incident: dropped messages sat dead for
 *  hours after the pool recovered until the user re-sent them by hand -
 *  superseding the older drop-instead-of-promise rule, whose premise was that
 *  a will-resume promise could not be kept; the marker + scheduler + startup
 *  scan make it durable). Only an UNKNOWN recovery time still drops honestly.
 *  The deadline is fixed when the message's relay starts, so chained parks
 *  can never hold the queue slot longer than PARK_MAX_MS in total. */
export function parkPlan(input: { decision: SwapDecision; recoveries: number; deadline: number }): ParkPlan {
  const depleted = input.decision.reason === "all-depleted" || input.decision.reason === "depleted-wait";
  if (!depleted) return { kind: "proceed" };
  const wake = input.decision.waitUntil ?? null;
  if (wake == null) return { kind: "drop" };
  // the grace counts against the deadline too: the promised total hold is
  // exact, not deadline-plus-grace (review catch, PR #18).
  if (wake + PARK_GRACE_MS > input.deadline || input.recoveries >= MAX_RECOVERIES) {
    return { kind: "defer", resumeAt: wake + PARK_GRACE_MS };
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
  ledger: () => { chunks: SegmentChunk[]; confirmed: number };
} {
  const chunks: SegmentChunk[] = [];
  let cursor = 0;
  let confirmed = 0;
  let done = false;
  let notify: (() => void) | null = null;
  return {
    push(chunk) {
      chunks.push(chunk);
      notify?.();
    },
    end() {
      done = true;
      notify?.();
    },
    /** Everything ever pushed plus how much of it the consumer PROVED
     *  delivered. The Slack adapter pulls one chunk, awaits its Slack append,
     *  then pulls the next (verified in @chat-adapter/slack 4.34.0 stream()),
     *  so each pull confirms the append for the previous chunk landed; a
     *  consumer that dies mid-append unwinds the for-await with an implicit
     *  return() at the yield, leaving that chunk and everything after it
     *  unconfirmed. */
    ledger() {
      return { chunks: [...chunks], confirmed };
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (cursor < chunks.length) {
            const next = chunks[cursor]!;
            cursor += 1;
            yield next;
            confirmed = cursor;
          }
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

/** Full permission names of the in-process tools (mcp__<server>__<tool>):
 *  they must be in allowedTools, because no one can answer a permission
 *  prompt through Slack. */
const FINISH_THREAD_TOOL = "mcp__tokenmaxxing__finish_thread";
const NEED_ATTENTION_TOOL = "mcp__tokenmaxxing__need_attention";

/** The per-turn in-process MCP server exposing finish_thread and
 *  need_attention. The handlers run in the daemon process, but they must NOT
 *  act inline: the claude subprocess is still mid-turn and segments are still
 *  streaming to Slack, so each only records the request and the daemon acts
 *  after the turn ends (serve.ts). alwaysLoad keeps the tools visible in the
 *  prompt instead of deferred behind tool search: they have to be in view at
 *  the exact moment the user says the work is done or the model hits a fork. */
function serveToolServer(input: { onFinish: () => void; onAttention: () => void }) {
  return createSdkMcpServer({
    name: "tokenmaxxing",
    alwaysLoad: true,
    tools: [
      tool(
        "finish_thread",
        "Close out this Slack thread when the user clearly states the work is finished (shipped, done, clean this up) and wants the thread closed. After this turn ends the daemon drops the thread's session record, unsubscribes, and posts a confirmation; the repo checkout and everything in it are untouched. Do not call this for a merely answered question - only for an explicit wrap-up.",
        {},
        async () => {
          input.onFinish();
          return { content: [{ type: "text", text: "close-out scheduled - it runs right after this turn ends and posts its own confirmation; just acknowledge the wrap-up now" }] };
        },
      ),
      tool(
        "need_attention",
        "Flag this Slack thread as waiting on the requesting user. Call it in the same turn in which you ask them for a decision, approval, or missing information (the ask-the-user skill), then ask in your reply text with their mention token and end the turn. After the turn ends the daemon marks the thread attention-needed (a question-mark reaction on the triggering message) and tags the user once more if they stay quiet; a reaction from them, such as a thumbs up, relays back to you as their answer. Do not call this for rhetorical questions or ordinary replies.",
        {},
        async () => {
          input.onAttention();
          return { content: [{ type: "text", text: "attention flagged - after this turn ends the daemon marks the thread as waiting on the user and nudges them if they stay quiet; ask your question in the reply text with their mention token, then end the turn" }] };
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
 * One claude turn relayed into a Slack thread as ONE streamed message: reply
 * text streams natively and thinking/tool calls stream as task_update cards
 * (see slackstream.ts) that Slack groups into a single collapsible plan block
 * (user ask 2026-07-20: "squash them into one dropdown"; the serve edge wraps
 * each posted segment in a StreamingPlan with groupTasks "plan", superseding
 * the 2026-07-18 separate-messages-around-tool-runs shape). Segments still
 * exist as the posting machinery: recovery notices post as their own
 * messages, a rejected post opens a fresh one (so an over-long turn that
 * trips Slack's message cap degrades to a follow-on message instead of
 * vanishing), and segments post strictly in order: the next opens only after
 * the previous post resolves. Never throws: a failure posts a short
 * diagnostic line and sets outcome.failed (the daemon must keep serving other
 * threads). Error text is message-only - a raw error body could echo request
 * material.
 *
 * Depleted-pool recovery (ported from slaude at its shutdown, reshaped around
 * the pool): the spawn-boundary switch decision is CONSUMED, not discarded -
 * a depleted pool parks BEFORE a doomed spawn burns a failed turn, with an
 * honest in-thread notice either way; a mid-turn limit the cached pool state
 * did not predict is persisted (recordObservedLimit) and retried silently into
 * the same session. Total in-handler parking is bounded by one shared
 * PARK_MAX_MS deadline plus MAX_RECOVERIES; a limit whose recovery lands
 * beyond that budget DEFERS instead of dropping (outcome.deferUntil): the
 * caller keeps the thread's durable marker with resumeAt and the daemon
 * resumes the turn itself once the pool recovers (2026-07-20 incident).
 * Only an unknown recovery time still drops, and every drop the relay itself
 * performs is announced in-thread (a queue-entry TTL expiry upstream is the
 * one drop it cannot see).
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
  const outcome: TurnOutcome = { sessionId: input.sessionId, failed: false, rateLimited: false, finish: false, attention: false, announcedDrop: false, resultReceived: false, deferUntil: null };
  let segment: ReturnType<typeof pushableStream> | null = null;
  // acc mirrors the segment's pushed text (bounded by SEGMENT_TEXT_MAX plus a
  // small overshoot): fence parity must be computed over the ACCUMULATED text,
  // never per chunk - SDK deltas do not respect markdown token boundaries, so
  // a ``` split across two deltas would be invisible to per-chunk counting
  // (pullfrog review catch, PR #42).
  let segmentMeta: { text: boolean; acc: string; reopenFence: boolean } | null = null;
  let lastPost: Promise<unknown> = Promise.resolve();
  // Reply TEXT that died with a rejected segment and was neither salvaged into
  // a follow-on message nor re-delivered by a later text-bearing segment: the
  // user has not seen the answer. A lost card-only segment never sets this
  // (decoration, not the answer). Tradeoff (flagged and accepted): a later
  // delivered text segment clears the flag even though it is a continuation,
  // because a rejection whose text chunks were all consumed pre-append-failure
  // was almost certainly delivered (the adapter appends per chunk) except for
  // an unobservable renderer-held tail; sticky loss would fail every long turn
  // with a spurious diagnostic.
  let textLost = false;
  let textLostDetail: string | null = null;
  let postedText = false;
  // Salvage: a rejected post's undelivered chunks re-post as a fresh message
  // (Slack finalizes an idle stream after an UNDOCUMENTED window - verified
  // absent from the chat.startStream/appendStream docs 2026-07-21 - so
  // recovery is reactive on any append failure, never a keepalive tuned to a
  // guessed constant). The budget bounds FUTILITY, not recovery: a death
  // after the message delivered something is progress and refills it (a long
  // turn can outlive any number of idle finalizations, each losing only the
  // gap tail), while a surface that delivers nothing (revoked channel, hard
  // cap on the very first append) burns a strike per attempt and stops.
  const MAX_SEGMENT_SALVAGES = 5;
  let salvagesLeft = MAX_SEGMENT_SALVAGES;
  const openSegment = () => {
    const seg = pushableStream();
    segment = seg;
    // reopenFence: the delivered prefix of a REJECTED predecessor left a code
    // fence open, so the first TEXT entering this salvage segment must be
    // preceded by a reopen or it renders outside the code block. Pending
    // rather than pushed eagerly (pullfrog catches, PR #42): a card-only
    // salvage would otherwise either skip the reopen (later text joining the
    // segment renders unfenced) or dangle an empty open fence at message end
    // when no text ever follows. Materialized by BOTH text entry points.
    const meta = { text: false, acc: "", reopenFence: false };
    segmentMeta = meta;
    lastPost = input.post(seg.iterable).then(
      () => {
        salvagesLeft = MAX_SEGMENT_SALVAGES;
        // segments settle in order (push awaits lastPost before opening the
        // next), so delivered text supersedes an earlier loss.
        if (meta.text) textLost = false;
      },
      (e: unknown) => {
        const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        log("serve.post_error", { err: detail });
        // the consumer is gone (e.g. Slack finalized an idle stream:
        // message_not_in_streaming_state). Salvage runs in TEXT space, not
        // chunk space, because the adapter's renderer buffers across chunks
        // (it holds back the trailing unterminated line, unconfirmed table
        // headers, and unclosed inline markers until the post-iteration
        // finish() flush - pullfrog catch on PR #45: a reply whose last line
        // has no trailing newline dies entirely in that forced flush, with
        // every chunk already consumed). Proven-delivered text = the mirror
        // renderer's committable prefix over the CONFIRMED chunks (each pull
        // proves the previous append landed; the adapter runs the renderer
        // with wrapTablesForAppend: false, so committable is a raw prefix and
        // the mirror is chunking-invariant). Renderer drift would break the
        // prefix check and degrade to a full re-post: duplication, never
        // loss. Same tradeoff for a stop()-failure after a complete flush:
        // the held tail re-posts once rather than risking silent loss.
        const { chunks, confirmed } = seg.ledger();
        if (segment === seg) segment = null;
        const confirmedRaw = chunks
          .slice(0, confirmed)
          .flatMap((c) => (c instanceof Object ? [] : [c]))
          .join("");
        const fullRaw = chunks.flatMap((c) => (c instanceof Object ? [] : [c])).join("");
        const mirror = new StreamingMarkdownRenderer({ wrapTablesForAppend: false });
        mirror.push(confirmedRaw);
        const committed = mirror.getCommittableText();
        const deliveredLen = confirmedRaw.startsWith(committed) ? committed.length : 0;
        const textRemainder = fullRaw.slice(deliveredLen);
        // A confirmed card's append landed (the adapter sends a card inline
        // in the loop body before the next pull), so unconfirmed cards are
        // the set it never appended.
        const deliveredCard = chunks.slice(0, confirmed).some((c) => c instanceof Object);
        // Delivery progress means this death does not count toward the
        // futility budget: only a message that delivered nothing burns one.
        // The key is ACTUAL delivery (committable text or a landed card),
        // never chunk consumption: a reply whose final line has no trailing
        // newline is consumed whole (confirmed advances) while its only
        // append is the post-iteration forced flush, so a consumption key
        // would refill the budget on every persistently failing flush and
        // salvage the same held-back text forever (vercel review catch,
        // PR #45). deliveredLen stays 0 there, the strike is spent, and the
        // zero-delivery case terminates.
        if (deliveredLen > 0 || deliveredCard) salvagesLeft = MAX_SEGMENT_SALVAGES;
        // The salvage sequence preserves STREAM ORDER (cursor review catch,
        // PR #45: re-posting all remainder text and then all cards showed
        // task cards after prose that originally followed them): walk the
        // ledger in order, keeping each text chunk's undelivered suffix and
        // each unconfirmed card at its original position. Text splits at
        // line boundaries (rendering is unchanged: chunks concatenate) so a
        // salvage message that dies too still confirms per line, keeping
        // progress attribution fine-grained.
        const lost: SegmentChunk[] = [];
        let offset = 0;
        for (const [i, c] of chunks.entries()) {
          if (c instanceof Object) {
            if (i >= confirmed) lost.push(c);
            continue;
          }
          const end = offset + c.length;
          let rest = end > deliveredLen ? c.slice(Math.max(0, deliveredLen - offset)) : "";
          offset = end;
          while (rest !== "") {
            const nl = rest.indexOf("\n");
            if (nl === -1) {
              lost.push(rest);
              break;
            }
            lost.push(rest.slice(0, nl + 1));
            rest = rest.slice(nl + 1);
          }
        }
        // A fence OPENED in the delivered prefix leaves later code fenceless
        // in the fresh salvage message (pullfrog catches, PR #42): arm the
        // segment's pending reopen, materialized right before the FIRST text
        // that enters it - whether a salvaged remainder piece here or a later
        // streamed push joining the segment (a card-only salvage must not
        // skip the reopen, and a text-less segment must not dangle one).
        // Fold this dying segment's OWN still-armed reopen into the parity:
        // an armed-but-never-materialized reopenFence means the segment
        // logically BEGAN inside an open fence (a card-only salvage that
        // inherited one and died before any text materialized it), so that
        // open state must propagate to the next salvage or its later text
        // renders unfenced (vercel + cubic chained-salvage catch, PR #42).
        // Once materialized, reopenFence is false and the reopen chunk is in
        // fullRaw, so the XOR is a no-op; a normal segment's flag is false.
        const deliveredFenceOpen =
          ((fullRaw.slice(0, deliveredLen).split("```").length - 1) % 2 === 1) !== meta.reopenFence;
        if (lost.length > 0 && salvagesLeft > 0) {
          salvagesLeft -= 1;
          log("serve.post_salvage", { chunks: lost.length, left: salvagesLeft });
          // this handler runs synchronously as the post settles, so opening
          // the salvage segment here keeps the salvaged content ordered ahead
          // of any push still awaiting lastPost; the salvage segment's own
          // settle then decides whether its text counts as delivered.
          const next = openSegment();
          next.meta.reopenFence = deliveredFenceOpen;
          for (const c of lost) next.pushInto(c);
        } else if (textRemainder !== "") {
          textLost = true;
          textLostDetail = detail;
        }
      },
    );
    const pushInto = (chunk: SegmentChunk) => {
      // meta.text only, NEVER postedText: salvaged text was already counted
      // at its original push, and postedText is attempt-scoped - a salvage
      // landing after a retry reset would otherwise re-arm it and suppress
      // the retry's `!postedText && result` fallback, silently dropping a
      // result-only answer (adversarial-review catch on PR #45). acc still
      // accumulates: it mirrors the segment's FULL text on every entry path,
      // so pushText's room accounting and fence parity see salvaged text too
      // (a salvage segment that continued via pushText could otherwise grow
      // past the msg_too_long cap).
      if (!(chunk instanceof Object)) {
        if (meta.reopenFence) {
          meta.reopenFence = false;
          meta.acc += "```\n";
          seg.push("```\n");
        }
        meta.text = true;
        meta.acc += chunk;
      }
      seg.push(chunk);
    };
    return { seg, meta, pushInto };
  };
  const push = async (chunk: SegmentChunk) => {
    if (segment === null) {
      await lastPost; // strict message order: previous segment fully posted first
      // a rejection handler may have opened a salvage segment during the wait;
      // joining it instead of opening another keeps its post from being
      // orphaned un-ended.
    }
    const target = segment ?? openSegment().seg;
    if (!(chunk instanceof Object)) {
      // materialize a salvage segment's pending fence reopen (see
      // openSegment) before the first text from this entry point too.
      if (segmentMeta!.reopenFence) {
        segmentMeta!.reopenFence = false;
        segmentMeta!.acc += "```\n";
        target.push("```\n");
      }
      postedText = true;
      segmentMeta!.text = true;
      segmentMeta!.acc += chunk;
    }
    target.push(chunk);
  };
  // parity by occurrence count over the segment's accumulated text: an odd
  // number of ``` markers means the segment currently sits inside a fence.
  const fenceOpen = () => segmentMeta !== null && (segmentMeta.acc.split("```").length - 1) % 2 === 1;
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
      const room = SEGMENT_TEXT_MAX - (segment === null ? 0 : segmentMeta!.acc.length);
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
      let cut = nl >= Math.floor(room / 2) ? nl + 1 : room;
      // never slice through a backtick run: a cut inside ``` would strand a
      // partial delimiter on each side and break both halves' rendering
      // (cubic review catch, PR #42). Walk the cut left past the run; a run
      // reaching position 0 keeps the original cut (progress beats rendering
      // for pathological all-backtick input).
      if (rest[cut - 1] === "`" && rest[cut] === "`") {
        let backedUp = cut;
        while (backedUp > 0 && rest[backedUp - 1] === "`") backedUp -= 1;
        if (backedUp > 0) cut = backedUp;
      }
      const head = rest.slice(0, cut);
      await push(head);
      const reopen = fenceOpen();
      if (reopen) await push("\n```");
      breakSegment();
      rest = (reopen ? "```\n" : "") + rest.slice(head.length);
    }
  };
  // settle the whole post chain: a rejection handler may replace lastPost with
  // a salvage segment's post, which still needs ending and settling.
  const settlePosts = async () => {
    while (true) {
      breakSegment();
      const settled = lastPost;
      await settled;
      if (lastPost === settled) return;
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
    await settlePosts();
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

  // a non-limit failure line held back until the depleted-pool probe rules:
  // posted verbatim on a plain failure, discarded when the turn defers (the
  // deferral notice explains the pause; the raw line would invite a manual
  // re-send of work the daemon resumes itself - cubic catch, PR #44).
  let pendingFailureLine: string | null = null;
  const runQueryOnce = async () => {
    postedText = false;
    pendingFailureLine = null;
    outcome.failed = false;
    outcome.rateLimited = false;
    outcome.resultReceived = false;
    // outcome.finish and outcome.attention stay sticky across retries: the
    // tool calls already happened in this session, and a limit right after
    // one must not unfinish the thread or drop the pending ask.
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
          // the user saying "we're done" closes the thread, and the model
          // asking the user for a decision marks it waiting: both flagged via
          // in-process tools, both acted on by the daemon post-turn. Like
          // finish, attention stays sticky across retries: the tool call
          // already happened in this session.
          mcpServers: {
            tokenmaxxing: serveToolServer({
              onFinish: () => { outcome.finish = true; },
              onAttention: () => { outcome.attention = true; },
            }),
          },
          allowedTools: [FINISH_THREAD_TOOL, NEED_ATTENTION_TOOL],
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
          if (part instanceof Object) await push(part);
          else await pushText(part);
        }
      }
      // a turn that produced no streamed text (tool-only turns) still reports.
      if (!postedText && result) await pushText(result);
      if (!postedText && !result && outcome.failed && !outcome.rateLimited) {
        // held back until the depleted-pool probe rules: a "trying again may
        // help" line right before a deferral notice invites a manual re-send
        // of work the daemon is about to resume itself (cubic catch, PR #44).
        pendingFailureLine = "the turn ended without a result - trying again may help";
      }
    } catch (e) {
      outcome.failed = true;
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      outcome.rateLimited = isRateLimitText({ text: detail });
      if (outcome.rateLimited) await recordObservedLimit({ text: detail, now: Date.now(), org: spawnOrg });
      log("serve.turn_error", { err: detail });
      // same hold-back: the detail already reached the log above, and a
      // deferral's own notice explains the pause better than a raw child
      // error that reads as "please re-send".
      if (!outcome.rateLimited) pendingFailureLine = `tokenmaxxing: turn failed: ${detail}`;
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
      // recovery time unknown: an auto-resume promise would be unkeepable,
      // so the honest drop survives for exactly this case.
      outcome.failed = true;
      outcome.rateLimited = true;
      log("serve.pool_depleted_drop", {});
      outcome.announcedDrop = await notifyDelivered("every pooled account is at its usage limit (recovers at an unknown time) - this message was dropped; re-send it once the pool recovers.");
      break;
    }
    if (plan.kind === "defer") {
      // release the queue slot and let the daemon resume the turn from its
      // durable marker once the pool recovers (2026-07-20 incident: dropped
      // messages sat dead for hours after recovery until re-sent by hand).
      outcome.failed = true;
      outcome.rateLimited = true;
      outcome.deferUntil = plan.resumeAt;
      log("serve.pool_depleted_defer", { resumeAt: plan.resumeAt });
      await notify(`every pooled account is at its usage limit - holding this message; it will resume automatically in ${inWord(plan.resumeAt)}.`);
      break;
    }
    if (plan.kind === "park") {
      recoveries += 1;
      log("serve.pool_depleted_park", { wakeAt: plan.wakeAt, recoveries });
      await notify(`every pooled account is at its usage limit - holding this message and retrying in ${inWord(plan.wakeAt)}.`);
      if (!(await sleep(plan.wakeAt - Date.now()))) {
        // a drain aborted the park: the turn never spawned, so the marker
        // survives (presumedKilled) and the next daemon start replays it.
        outcome.failed = true;
        await notify("tokenmaxxing is restarting - this message resumes after the restart.");
        break;
      }
      continue;
    }
    await runQueryOnce();
    if (!outcome.failed) break;
    if (!outcome.rateLimited) {
      // an unclassifiable child failure (e.g. "Claude Code process exited
      // with code 1" - the 2026-07-20 Fable-cap death carried no limit
      // phrase) against an exhausted pool IS the limit: the pool state is
      // the evidence the error text did not carry. A completed result stays
      // terminal, and a usable pool keeps the plain failure.
      if (!outcome.resultReceived) {
        try {
          const verdict = await ensureBestAccount();
          const depleted = verdict.reason === "all-depleted" || verdict.reason === "depleted-wait";
          const wake = depleted ? verdict.waitUntil ?? null : null;
          if (wake != null) {
            outcome.rateLimited = true;
            outcome.deferUntil = wake + PARK_GRACE_MS;
            pendingFailureLine = null;
            log("serve.turn_failed_depleted_defer", { resumeAt: outcome.deferUntil });
            await notify(`the account pool is exhausted - pausing this turn; it will resume automatically in ${inWord(outcome.deferUntil)}.`);
          }
        } catch (e) {
          // keep the original failure; the probe must never mask it.
          log("serve.defer_probe_error", { err: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
        }
      }
      if (pendingFailureLine !== null) await push(pendingFailureLine);
      break;
    }
    if (recoveries >= MAX_RECOVERIES) {
      // out of in-handler retry budget: defer to the pool's own recovery
      // clock when it is known, drop honestly when it is not (a stale cache
      // claiming a usable pool while every retry limits out lands here too,
      // and deferring on no evidence would just spin the resume cap).
      let wake: number | null = null;
      try {
        const verdict = await ensureBestAccount();
        const depleted = verdict.reason === "all-depleted" || verdict.reason === "depleted-wait";
        wake = depleted ? verdict.waitUntil ?? null : null;
      } catch (e) {
        log("serve.defer_probe_error", { err: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
      }
      if (wake != null) {
        outcome.deferUntil = wake + PARK_GRACE_MS;
        log("serve.rate_limited_defer", { recoveries, resumeAt: outcome.deferUntil });
        await notify(`still at a usage limit after retries - pausing this turn; it will resume automatically in ${inWord(outcome.deferUntil)}.`);
        break;
      }
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
      // a drain aborted the retry sleep: same as a killed child, the marker
      // survives (presumedKilled) and the next daemon start resumes the
      // session where it stopped.
      outcome.failed = true;
      await notify("tokenmaxxing is restarting - this turn resumes after the restart.");
      break;
    }
  }
  await settlePosts();
  // Reply text died with a rejected segment, salvage could not re-deliver it
  // (budget exhausted or the salvage posts died too), and nothing later
  // re-delivered it: the answer silently vanished while the outcome would
  // report success. Fail the turn and make one best-effort fresh-message
  // diagnostic.
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
