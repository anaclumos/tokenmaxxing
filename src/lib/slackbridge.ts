// The Slack->claude relay. One claude turn per Slack message via the Agent SDK
// (re-query with resume, never a persistent streaming query: the SDK subprocess
// reads credentials at spawn, so per-turn spawns are what let the pool decision
// pick the freshest account at every boundary and let the daemon restart
// without losing threads). Verified against @anthropic-ai/claude-agent-sdk
// 0.3.214 and code.claude.com/docs 2026-07-18; both change monthly.

import { z } from "zod";
import { delay } from "es-toolkit";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { StreamChunk } from "chat";
import { ensureBestAccount, pooledOptions, stopHookCheck, type SwapDecision } from "../sdk.ts";
import { readOAuthAccount } from "./claudejson.ts";
import { http, safeErrorDetail } from "./http.ts";
import { fmtResetShort, recordObservedLimit } from "./usage.ts";
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
  /** the FAILED turn hit a usage/rate limit (or the pool was depleted before
   *  it could spawn). Only an errored result is ever limit-classified. */
  rateLimited: z.boolean(),
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

export const ParkPlanSchema = z.union([
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
export function parkPlan(input: { decision: SwapDecision; now: number; recoveries: number; deadline: number }): ParkPlan {
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
  link: SlackLink;
  post: (m: AsyncIterable<SegmentChunk>) => Promise<unknown>;
  /** daemon shutdown signal: aborts park/retry sleeps so a drain never sits
   *  out a depleted-pool countdown. */
  drainSignal?: AbortSignal;
}): Promise<TurnOutcome> {
  const outcome: TurnOutcome = { sessionId: input.sessionId, failed: false, rateLimited: false };
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
  // a recovery status line reads as its own Slack message, not part of a
  // streamed segment.
  const notify = async (text: string) => {
    breakSegment();
    await push(text);
    breakSegment();
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
    // the identity this spawn meters: a limit observation is attributed to it,
    // never to whatever account a concurrent thread swaps live mid-turn. Read
    // inside the try: a malformed claude.json must fail the TURN, not the
    // relay's never-throws contract.
    let spawnOrg: string | null = null;
    try {
      spawnOrg = readOAuthAccount()?.organizationUuid ?? null;
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
          // a retry resumes the session the failed attempt opened, so no
          // context is lost across recoveries.
          ...(outcome.sessionId ? { resume: outcome.sessionId } : {}),
        },
      });
      const mapState = newStreamMapState();
      let result: string | null = null;
      for await (const message of q) {
        if (message.type === "system" && message.subtype === "init") outcome.sessionId = message.session_id;
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
            if (outcome.rateLimited) recordObservedLimit({ text, now: Date.now(), org: spawnOrg });
          } else {
            result = message.result;
          }
        }
        for (const part of agentEventChunks({ state: mapState, message })) {
          if (SegmentBreakSchema.safeParse(part).success) breakSegment();
          else await push(SegmentChunkSchema.parse(part));
        }
      }
      // a turn that produced no streamed text (tool-only turns) still reports.
      if (!postedText && result) await push(result);
      if (!postedText && !result && outcome.failed && !outcome.rateLimited) {
        await push("the turn ended without a result - trying again may help");
      }
    } catch (e) {
      outcome.failed = true;
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      outcome.rateLimited = isRateLimitText({ text: detail });
      if (outcome.rateLimited) recordObservedLimit({ text: detail, now: Date.now(), org: spawnOrg });
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
    const plan = parkPlan({ decision, now: Date.now(), recoveries, deadline: parkDeadline });
    if (plan.kind === "drop") {
      outcome.failed = true;
      outcome.rateLimited = true;
      log("serve.pool_depleted_drop", { recoversAt: plan.recoversAt });
      await notify(`every pooled account is at its usage limit (recovers in ${inWord(plan.recoversAt)}) - this message was dropped; re-send it once the pool recovers.`);
      break;
    }
    if (plan.kind === "park") {
      recoveries += 1;
      log("serve.pool_depleted_park", { wakeAt: plan.wakeAt, recoveries });
      await notify(`every pooled account is at its usage limit - holding this message and retrying in ${inWord(plan.wakeAt)}.`);
      if (!(await sleep(plan.wakeAt - Date.now()))) {
        outcome.failed = true;
        await notify("tokenmaxxing is restarting - this message was dropped; please re-send it.");
        break;
      }
      continue;
    }
    await runQueryOnce();
    if (!outcome.failed || !outcome.rateLimited) break;
    if (recoveries >= MAX_RECOVERIES) {
      log("serve.rate_limited_drop", { recoveries });
      await notify("still at a usage limit after retries - this message was dropped; reply when you want to try again.");
      break;
    }
    // a limit the cached pool state did not predict: give the pool one beat
    // to observe it, then re-decide and retry the same prompt into the same
    // session (slaude's silent short retry - a successful swap makes it
    // invisible in the thread).
    recoveries += 1;
    breakSegment();
    log("serve.rate_limited_retry", { recoveries });
    if (!(await sleep(RETRY_DELAY_MS))) {
      outcome.failed = true;
      await notify("tokenmaxxing is restarting - this message was dropped; please re-send it.");
      break;
    }
  }
  breakSegment();
  await lastPost;
  return outcome;
}
