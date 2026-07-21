// `tokenmaxxing serve` - the Slack bridge daemon. Socket Mode (no public URL):
// a mention in a linked channel opens a claude session for that thread IN the
// linked repo checkout (normal mode, user decision 2026-07-18 superseding the
// same-day worktree-per-thread default: a thread's agent cuts its own worktree
// only when a task needs isolation, guidance in `.memory`), and every further
// thread message becomes one claude turn whose streamed output posts back into
// the thread. Stack chosen by the user 2026-07-18: Vercel Chat SDK (`chat` +
// `@chat-adapter/slack`) for Slack, the Claude Agent SDK driven through
// src/sdk.ts for claude (EVE was researched and dropped: it owns its own model
// loop instead of driving Claude Code).
//
//   serve setup            print the app manifest + prompt for the two tokens
//   serve link <ch> <repo> [--dangerous] [--model <m>]
//   serve unlink <ch>      remove a link
//   serve links            list links
//   serve                  run the daemon

import { existsSync, realpathSync } from "node:fs";
import { delay, omit, uniq } from "es-toolkit";
import { z } from "zod";
import { Chat, StreamingPlan, ThreadImpl, type StreamChunk } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  bareChannelId,
  isChannelId,
  isOutsideAuthor,
  linkForChannel,
  listSlackThreads,
  loadSlackConfig,
  loadSlackThread,
  removeLink,
  resumeDecision,
  saveSlackConfig,
  saveSlackThread,
  stripLeadingMention,
  upsertLink,
  SlackLinkSchema,
  type ActiveTurn,
  type SlackConfig,
  type SlackLink,
  type SlackThread,
} from "../lib/slackstate.ts";
import { cleanupThread, fetchWorkspaceTeamId, killGroup, relayThread, type CleanupOutcome, type TurnOutcome } from "../lib/slackbridge.ts";
import { ensureBestAccount, type SwapDecision } from "../sdk.ts";
import { pidStartTime } from "../lib/proc.ts";
import { acquireLock } from "../lib/lock.ts";
import { paths } from "../lib/paths.ts";
import { log, setLogEcho } from "../lib/log.ts";
import { c, count } from "./render.ts";

const SERVE_USAGE = "usage: tokenmaxxing serve [setup | link <channel-id> <repo> [--yolo | --dangerous] [--model <m>] | unlink <channel-id> | links]";

/** The manifest the user pastes at api.slack.com/apps > From an app manifest.
 *  Scopes/events verified against docs.slack.dev 2026-07-18: a channel-thread
 *  relay plus Slack's Agent messaging experience (agent_view + assistant:write
 *  power the DM assistant surface and typing status; channel-thread streaming
 *  works without them, verified live). agent_view is an OBJECT whose required
 *  field is agent_description (max 300 chars; docs.slack.dev app-manifest
 *  reference, re-verified 2026-07-20) - a bare `agent_view: true` is rejected
 *  with "Must provide an object". Changing scopes on an existing app requires
 *  reinstalling it to the workspace. */
const APP_MANIFEST = `display_information:
  name: tokenmaxxing
  description: bridges Slack threads to Claude Code sessions

features:
  agent_view:
    agent_description: bridges Slack threads to Claude Code sessions
  bot_user:
    display_name: tokenmaxxing
    always_online: true

oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - assistant:write
      - channels:history
      - groups:history
      - chat:write
      - files:write
      - im:history
      - users:read

settings:
  event_subscriptions:
    bot_events:
      - app_context_changed
      - app_home_opened
      - app_mention
      - message.channels
      - message.groups
      - message.im
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false`;

function printSetupInstructions(): void {
  console.log(c.bold("Slack app setup (one time)"));
  console.log(`1. Open ${c.cyan("https://api.slack.com/apps")} > Create New App > From an app manifest, pick your workspace, and paste:`);
  console.log();
  console.log(APP_MANIFEST);
  console.log();
  console.log("2. OAuth & Permissions > Install to Workspace, copy the Bot User OAuth Token (xoxb-...).");
  console.log("3. Basic Information > App-Level Tokens > Generate (add the connections:write scope), copy the token (xapp-...).");
  console.log(`4. Run ${c.cyan("tokenmaxxing serve setup")} and paste both tokens, then ${c.cyan("tokenmaxxing serve link <channel-id> <repo>")} and invite the bot to that channel.`);
  console.log(`${c.dim("Existing app? Paste the manifest over App Manifest in its settings, then reinstall to the workspace (scope changes need it). Tokens stay valid unless you rotate them.")}`);
}

async function cmdServeSetup(): Promise<number> {
  printSetupInstructions();
  console.log();
  const botToken = prompt("bot token (xoxb-...):")?.trim();
  const appToken = prompt("app token (xapp-...):")?.trim();
  if (!botToken || !appToken) {
    console.error(c.red("both tokens are required - nothing saved"));
    return 1;
  }
  const existing = loadSlackConfig();
  let cfg: SlackConfig;
  try {
    cfg = { botToken, appToken, links: existing?.links ?? [] };
    saveSlackConfig(cfg);
  } catch {
    console.error(c.red("tokens rejected: the bot token must start with xoxb- and the app token with xapp-"));
    return 1;
  }
  // the external-author guard needs the home workspace id; capture it from the
  // token itself so the reference can never drift from the workspace the bot
  // actually lives in (re-captured on every setup: new tokens may belong to a
  // different workspace).
  try {
    cfg = { ...cfg, workspaceTeamId: await fetchWorkspaceTeamId({ botToken }) };
    saveSlackConfig(cfg);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(c.red(`tokens saved, but ${detail} - check the bot token; the daemon re-tries the capture at start`));
    return 1;
  }
  console.log(`${c.green("✓")} saved to slack.json (0600) for workspace ${cfg.workspaceTeamId} with ${count({ n: cfg.links.length, noun: "link" })}`);
  return 0;
}

function cmdServeLink(argv: string[]): number {
  // yolo mode = the SDK's bypassPermissions; --dangerous is the same switch.
  const dangerous = argv.includes("--yolo") || argv.includes("--dangerous");
  const modelIdx = argv.indexOf("--model");
  const model = modelIdx >= 0 ? argv[modelIdx + 1] : undefined;
  const rest = argv.filter((a, i) => !a.startsWith("--") && (modelIdx < 0 || i !== modelIdx + 1));
  const [channel, repo] = rest;
  if (!channel || !repo) {
    console.error(SERVE_USAGE);
    return 2;
  }
  if (!isChannelId(channel)) {
    console.error(c.red(`"${channel}" is not a Slack channel id (C.../G...). In Slack: right-click the channel > View channel details - the id is at the bottom.`));
    return 1;
  }
  if (!existsSync(repo)) {
    console.error(c.red(`repo path does not exist: ${repo}`));
    return 1;
  }
  const repoReal = realpathSync(repo);
  if (!existsSync(`${repoReal}/.git`)) {
    console.error(c.red(`${repoReal} is not a git repository`));
    return 1;
  }
  const cfg = loadSlackConfig();
  if (!cfg) {
    console.error(c.red("no slack.json yet - run `tokenmaxxing serve setup` first"));
    return 1;
  }
  const link = SlackLinkSchema.parse({
    channel,
    repo: repoReal,
    permissionMode: dangerous ? "bypassPermissions" : "acceptEdits",
    ...(model ? { model } : {}),
  });
  saveSlackConfig(upsertLink(cfg, link));
  const flags = [link.permissionMode, ...(model ? [model] : [])].join(", ");
  console.log(`${c.green("✓")} linked ${c.bold(channel)} → ${repoReal} (${flags})`);
  return 0;
}

function cmdServeUnlink(channel: string | undefined): number {
  if (!channel) {
    console.error(SERVE_USAGE);
    return 2;
  }
  const cfg = loadSlackConfig();
  const next = cfg ? removeLink(cfg, channel) : null;
  if (!next) {
    console.error(c.red(`no link for channel ${channel}`));
    return 1;
  }
  saveSlackConfig(next);
  console.log(`${c.green("✓")} unlinked ${channel}`);
  return 0;
}

function cmdServeLinks(): number {
  const cfg = loadSlackConfig();
  if (!cfg || cfg.links.length === 0) {
    console.log(c.dim("no channel links - run `tokenmaxxing serve link <channel-id> <repo>`"));
    return 0;
  }
  for (const l of cfg.links) {
    const flags = [l.permissionMode, ...(l.model ? [l.model] : [])].join(", ");
    console.log(`${c.bold(l.channel)} → ${l.repo} ${c.dim(`(${flags})`)}`);
  }
  return 0;
}

/** Event-name endings that pick the terminal paint: red for failures, yellow
 *  for degraded-but-continuing conditions, cyan otherwise. Structural endsWith
 *  checks so new events inherit sensible colors from their naming. */
const RED_EVENT_ENDINGS = ["error", "failed", "invalid_grant"];
const YELLOW_EVENT_ENDINGS = ["_dropped", "_drift", "_unparsed", "_gave_up", "_abort", "forced_exit", "contested", "draining"];

function eventPaint(event: string): (s: string) => string {
  if (RED_EVENT_ENDINGS.some((ending) => event.endsWith(ending))) return c.red;
  if (YELLOW_EVENT_ENDINGS.some((ending) => event.endsWith(ending))) return c.yellow;
  return c.cyan;
}

/** One terminal line per log() event while the daemon runs: the file log stays
 *  canonical; this makes `xx serve` observable without tailing tokenmaxxing.log.
 *  Field values can carry newlines (e.g. usage.probe_failed's stderr excerpt),
 *  so they are escaped to keep the one-line-per-event contract. Exported for
 *  tests. */
export function formatLogLine(input: { event: string; parts: string }): string {
  const time = new Date().toLocaleTimeString("en-GB");
  const parts = input.parts.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
  return `${c.dim(time)} ${eventPaint(input.event)(input.event)}${parts ? ` ${parts}` : ""}`;
}

/** The slice of a Chat SDK thread the runtime touches. z.custom because it
 *  carries functions: the zod-native way to name the structural shape once for
 *  the daemon and test fakes alike. */
const ServeThreadSchema = z.custom<{
  id: string;
  channelId: string;
  post: (m: string | AsyncIterable<string | StreamChunk> | StreamingPlan) => Promise<unknown>;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  startTyping: () => Promise<void>;
}>();
type ServeThread = z.infer<typeof ServeThreadSchema>;

/** The slice of a Chat SDK message the author guard + folding read. */
const ServeMessageSchema = z.custom<{
  text: string;
  author: { userId: string; isMe: boolean; isBot?: boolean | "unknown" };
  raw?: unknown;
}>();
type ServeMessage = z.infer<typeof ServeMessageSchema>;

/** Reap a previous generation's detached claude child that survived an
 *  uncatchable daemon death (SIGKILL, crash: the "exit" event never fires
 *  on those, so the hook that kills the group never ran) - resuming beside
 *  a live orphan would put two claude processes on one cwd and session
 *  (adversarial-review catch). Signals fire ONLY on a verified pid+lstart
 *  identity match (cubic review catch: this machine runs the user's real
 *  claude sessions; a recycled pid must never get the kill). SIGTERM the
 *  group, escalate to SIGKILL if it lingers past the grace. */
async function reapOrphan(turn: ActiveTurn): Promise<void> {
  if (turn.pid === undefined || turn.pidStartedAt === undefined) return;
  if (pidStartTime(turn.pid) !== turn.pidStartedAt) return; // gone, or a recycled pid
  log("serve.orphan_reaped", { pid: turn.pid });
  killGroup(turn.pid);
  for (let i = 0; i < 10; i++) {
    await delay(500);
    if (pidStartTime(turn.pid) !== turn.pidStartedAt) return;
  }
  killGroup(turn.pid, "SIGKILL");
}

/**
 * The daemon's message-handling runtime, extracted from runDaemon as an
 * injectable seam so tests can drive the REAL handler wiring (author guard,
 * skipped-message folding, per-thread serialization, activeTurn markers,
 * drain drops, finish close-out) against fake threads and a fake relay.
 * runDaemon passes the production deps; behavior is identical. The startup
 * interrupted-turn recovery stays inline in runDaemon (it needs the live bot
 * and adapter for streamable thread handles) and reuses the chain/turn pieces
 * exposed here.
 */
export function buildServeRuntime(seam: {
  cfg: SlackConfig;
  workspaceTeamId: string;
  /** read per message: the adapter only learns its bot user id on connect. */
  botUserId: () => string | null;
  relay: (input: {
    cwd: string;
    sessionId: string | null;
    prompt: string;
    requesterIds: string[];
    link: SlackLink;
    post: (m: AsyncIterable<string | StreamChunk>) => Promise<unknown>;
    /** fires when init assigns a session id the caller has not persisted yet
     *  (see relayThread). */
    onSessionId?: (sessionId: string) => void;
    /** fires with the detached claude child's pid at each spawn (see
     *  relayThread). */
    onSpawn?: (pid: number) => void;
    drainSignal?: AbortSignal;
  }) => Promise<TurnOutcome>;
  cleanup: (input: { threadId: string }) => CleanupOutcome;
  /** builds a streamable proactive thread handle for marker recovery (startup
   *  resumes and deferred-turn wakes both need one). runDaemon passes a lazy
   *  closure over its bot-backed streamableThread; tests pass a fake. */
  streamable: (threadId: string) => Promise<{ thread: ServeThread; requesterIds: string[] }>;
  /** the pool decision a deferred wake pre-probes with before posting the
   *  recovery notice (production: ensureBestAccount; tests: a stub). */
  decide: () => Promise<SwapDecision>;
}) {
  const { cfg, workspaceTeamId } = seam;
  /** short re-arm after a deferred wake fails transiently (Slack hiccup at
   *  the resume): the durable marker keeps deferring, so the retry loop ends
   *  the moment any marker-clearing path runs. */
  const RESUME_RETRY_MS = 300_000;
  // in-flight turns, tracked so a shutdown signal can drain them instead of
  // killing a half-streamed answer (live incident 2026-07-18: a deploy
  // restart cut a turn mid-sentence and the answer never reached Slack).
  const activeTurns = new Set<Promise<void>>();
  // aborts depleted-pool park/retry sleeps on drain, so a countdown never
  // holds the restart hostage.
  const drainAbort = new AbortController();
  let draining = false;

  /** One relayed turn with the durable activeTurn marker around it: written
   *  before the spawn, cleared when the turn returns, so a marker surviving
   *  into the next daemon start identifies a turn a restart killed mid-run.
   *  The session id persists the moment init assigns it - a first-turn kill
   *  must stay resumable. */
  const runTurn = async (input: {
    thread: { id: string; post: (m: StreamingPlan) => Promise<unknown> };
    record: SlackThread;
    prompt: string;
    requesterIds: string[];
    sessionId: string | null;
    marker: ActiveTurn;
    link: SlackLink;
  }): Promise<TurnOutcome> => {
    let record: SlackThread = { ...input.record, activeTurn: input.marker };
    saveSlackThread(record);
    let outcome: TurnOutcome | null = null;
    try {
      outcome = await seam.relay({
        cwd: record.cwd,
        sessionId: input.sessionId,
        prompt: input.prompt,
        requesterIds: input.requesterIds,
        link: input.link,
        // every posted segment groups its task cards into one collapsible
        // Slack plan block (task_display_mode "plan"; user ask 2026-07-20:
        // "squash them into one dropdown") instead of a card-per-task
        // timeline. Text-only segments (notices, plain replies) carry no
        // tasks, so the wrap is a no-op for them.
        post: (m) => input.thread.post(new StreamingPlan(m, { groupTasks: "plan" })),
        onSpawn: (pid) => {
          // the lstart token makes the pid a verifiable identity for the
          // orphan reaper; a child dead before ps sees it persists without
          // one, and an identity-less pid is never signaled.
          const startedAt = pidStartTime(pid);
          record = { ...record, activeTurn: { ...input.marker, pid, ...(startedAt === null ? {} : { pidStartedAt: startedAt }) } };
          saveSlackThread(record);
        },
        onSessionId: (sessionId) => {
          record = { ...record, sessionId };
          saveSlackThread(record);
        },
        drainSignal: drainAbort.signal,
      });
      record = { ...record, sessionId: outcome.sessionId };
      return outcome;
    } finally {
      // a failure DURING a drain is presumed to be the shutdown signal killing
      // the claude child (terminal Ctrl-C and group signals hit the whole
      // process group, so the child dies and relayThread returns failed while
      // the daemon is still draining - codex review catch): keep the marker so
      // the next generation auto-resumes, exactly the killed-turn state it
      // exists to detect. Outside a drain, or on success, clear it.
      // An announced drop is TERMINAL: relayThread told the user to resend, so
      // retaining the marker would replay work the drop notice disclaimed
      // (duplicate turns, quota, side effects). A turn whose child reached a
      // SUCCESSFUL result is also terminal even when failed (that failure is
      // Slack delivery, not a killed child - resuming would re-run completed
      // work; adversarial-review catch). null outcome = relay threw =
      // still presumed killed.
      const presumedKilled = draining && (outcome === null || (outcome.failed && !outcome.announcedDrop && !outcome.resultReceived));
      // A usage-limit DEFERRAL keeps the marker with resumeAt: the turn
      // returned on purpose so the queue slot frees up, and the scheduler
      // resumes it from this durable record once the pool recovers.
      const deferUntil = outcome?.deferUntil ?? null;
      // An unannounced drop OUTSIDE a drain still clears the marker on
      // purpose (retention would re-execute the turn at the next restart; see
      // notifyDelivered's doc) - but the loss must be operator-visible.
      if (!draining && outcome !== null && outcome.failed && outcome.rateLimited && !outcome.announcedDrop && deferUntil === null) {
        log("serve.drop_unannounced", { thread: input.thread.id });
      }
      if (deferUntil !== null && record.activeTurn) {
        record = { ...record, activeTurn: { ...record.activeTurn, resumeAt: deferUntil } };
        saveSlackThread(record);
        scheduleDeferred(record.threadId, deferUntil);
      } else {
        saveSlackThread(presumedKilled ? record : omit(record, ["activeTurn"]));
      }
    }
  };

  const handleTurn = async (input: {
    thread: ServeThread;
    /** every relayed message this turn (queue-skipped + triggering), text
     *  paired with its author id: a decision may be owed to an earlier
     *  folded sender, and a sender whose whole message was the bot mention
     *  contributes no prompt text, so text and author filter together
     *  (review catches 2026-07-18). */
    relayed: { text: string; authorId: string }[];
    isMention: boolean;
  }) => {
    const { thread, isMention } = input;
    const link = linkForChannel(cfg, bareChannelId(thread.channelId));
    if (!link) {
      // checked BEFORE the draining branch: unlinked channels are
      // contractually log-only silent, and a drain-window drop notice posted
      // into one would tell a user to resend a message that will never be
      // served (closing-review catch).
      log("serve.unlinked_channel", { channel: thread.channelId });
      return; // not a linked channel - stay silent in Slack
    }
    if (draining) {
      // the socket stays connected until the drain finishes; anything landing
      // in that window is dropped loudly rather than spawning an unwaitable
      // turn - and the THREAD is told, not just the log (a silent drop reads
      // as the bot thinking; slaude's recorded drop-notice rule). Tracked so
      // the drain wait flushes it before exit; errors swallowed so the notice
      // can never fail the drain.
      log("serve.drain_dropped", { thread: thread.id });
      void tracked(
        (async () => {
          try {
            await thread.post(
              (async function* () {
                yield "tokenmaxxing is restarting - this message was dropped; please re-send it in a moment.";
              })(),
            );
          } catch (e) {
            // caught (never rethrown - the notice must not fail the drain)
            // but logged: an unposted notice means the user saw nothing.
            log("serve.drain_notice_failed", { thread: thread.id, err: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
          }
        })(),
      );
      return;
    }
    log("serve.message", { thread: thread.id, isMention, texts: input.relayed.length });
    // relayed carries queue-skipped messages plus the triggering one: the
    // queue strategy hands a turn only the LATEST message and the rest via
    // context.skipped, so they are folded into one prompt here. A message
    // that is empty once its bot mention is stripped contributes neither
    // prompt text nor a requester id (cursor review catch 2026-07-18).
    const stripped = input.relayed
      .map((m) => ({ text: stripLeadingMention({ text: m.text, botUserId: seam.botUserId() }), authorId: m.authorId }))
      .filter((m) => m.text !== "");
    let prompt = stripped.map((m) => m.text).join("\n\n");
    const requesterIds = uniq(stripped.map((m) => m.authorId));
    if (!prompt) return;
    // this whole handler runs inside the per-thread `serialized` chain (call
    // sites below), which startup resumes share too - so this load already
    // sees any session id a resume persisted, and no second claude process
    // can ever share this thread's cwd.
    let record = loadSlackThread(thread.id);
    if (!record) {
      if (!isMention) return; // only a mention opens a session
      record = { threadId: thread.id, repo: link.repo, cwd: link.repo, sessionId: null, createdAt: new Date().toISOString() };
      saveSlackThread(record);
      log("serve.thread_opened", { thread: thread.id, cwd: link.repo });
    }
    // Inside the serialized chain a surviving marker is either a PREVIOUS
    // generation's killed turn (an inbound message can win the chain ahead of
    // startup recovery, e.g. Slack redelivering the killed turn's unacked
    // mention) or a LIMIT-DEFERRED turn holding its resumeAt promise. Reap a
    // possible orphan either way, so two claude processes never share the
    // thread's cwd and session (closing-review catch: the recovery-path reap
    // alone loses this race).
    if (record.activeTurn) await reapOrphan(record.activeTurn);
    // An inbound message takes over a deferred thread (its wake timer dies
    // with the takeover; runTurn's fresh marker replaces the deferred one),
    // and the held prompt ALWAYS folds in front of the new text: silently
    // discarding it was the adversarial-review MAJOR catch on PR #44 (it
    // would re-lose exactly the 2026-07-20 two-message shape the deferral
    // exists to save), and no spawn-progress signal on the marker can prove
    // the held prompt ever reached the session (a child can spawn and die
    // before init - vercel review catch). A completed turn never defers, so
    // folding can never re-run finished work; at worst a mid-turn deferral's
    // prompt re-appears alongside the session transcript that already holds
    // its partial work, and the newer message steers.
    const deferred = record.activeTurn?.resumeAt !== undefined ? record.activeTurn : null;
    if (deferred) {
      const timer = deferredTimers.get(thread.id);
      if (timer !== undefined) clearTimeout(timer);
      deferredTimers.delete(thread.id);
      prompt = `${deferred.prompt}\n\n${prompt}`;
      log("serve.deferred_folded", { thread: thread.id });
    }
    // subscriptions live in the memory state, so a daemon restart forgets
    // them; every mention re-subscribes to keep follow-up replies flowing.
    if (isMention) await thread.subscribe();
    // "is working..." assistant status; a no-op until the Slack app has the
    // agent feature + assistant:write (the adapter warns instead of throwing).
    await thread.startTyping();
    const startedAt = Date.now();
    const outcome = await runTurn({
      thread,
      record,
      prompt,
      requesterIds,
      sessionId: record.sessionId,
      marker: { prompt, startedAt: new Date().toISOString(), resumeCount: 0 },
      link,
    });
    await settleTurn({ thread, outcome, startedAt });
  };

  /** Post-turn bookkeeping shared by inbound and resumed turns: the outcome
   *  log line, and the finish_thread garbage collection when the model called
   *  it. Never throws into the caller - the daemon must keep serving. */
  const settleTurn = async (input: {
    thread: { id: string; post: (m: string | AsyncIterable<string | StreamChunk>) => Promise<unknown>; unsubscribe: () => Promise<void> };
    outcome: TurnOutcome;
    startedAt: number;
  }) => {
    const { thread, outcome, startedAt } = input;
    log(outcome.deferUntil !== null ? "serve.turn_deferred" : outcome.failed ? "serve.turn_failed" : "serve.turn_done", {
      thread: thread.id,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      ...(outcome.deferUntil === null ? {} : { resumeAt: outcome.deferUntil }),
    });
    // the user declared the work finished: close the thread now that the
    // turn (and its claude subprocess) is over. Never throw into the caller -
    // the daemon must keep serving other threads.
    if (!outcome.finish) return;
    if (outcome.deferUntil !== null) {
      // finish is sticky across retries, so it can ride a deferred outcome -
      // and cleanup would delete the very record the deferral just promised
      // to resume (adversarial-review catch on PR #44). The deferral wins:
      // the resumed turn finishes the remaining work, and the user closes
      // the thread again once it actually lands.
      log("serve.finish_deferred", { thread: thread.id });
      return;
    }
    let result: CleanupOutcome;
    try {
      result = seam.cleanup({ threadId: thread.id });
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      log("serve.cleanup_error", { thread: thread.id, err: detail });
      try {
        await thread.post(`tokenmaxxing: cleanup failed: ${detail}`);
      } catch (postErr) {
        // the diagnostic is best-effort, but its failure is never silent.
        log("serve.finish_notify_error", { thread: thread.id, err: (postErr instanceof Error ? postErr.message : String(postErr)).slice(0, 300) });
      }
      return;
    }
    // the Slack calls are guarded too: this whole path must never throw into
    // the caller (review catch, PR #18) - the record is already gone, so a
    // failed confirmation only gets logged.
    try {
      // a refusal keeps the subscription so the thread stays live for a retry.
      if (result.removed) await thread.unsubscribe();
      await thread.post(result.message);
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      log("serve.finish_notify_error", { thread: thread.id, err: detail });
    }
    log("serve.thread_finished", { thread: thread.id, removed: result.removed });
  };

  const relayable = (m: ServeMessage) => {
    if (m.author.isMe || m.author.isBot === true) return false;
    // outsiders must not drive sessions (owner rule 2026-07-16, ported from
    // slaude): Slack Connect externals and cross-workspace guests are
    // rejected fail-closed - silent in Slack, loud in the log.
    if (isOutsideAuthor({ raw: m.raw, workspaceTeamId })) {
      log("serve.outside_author", {});
      return false;
    }
    return true;
  };

  const tracked = async (turn: Promise<void>) => {
    activeTurns.add(turn);
    try {
      await turn;
    } finally {
      activeTurns.delete(turn);
    }
  };

  // Per-thread serialization owned HERE, not only by the SDK's queue lock:
  // chat 4.34.0 acquires the dispatch lock with a 30s TTL and extends it only
  // BETWEEN dispatches, so any handler outliving 30s (every claude turn, any
  // depleted-pool park) lets a later message take the expired lock and start
  // a second concurrent handler in the same thread and cwd (review catch,
  // PR #18). Escaped messages run as sequential turns in arrival order.
  const threadTurns = new Map<string, Promise<void>>();
  const serialized = (threadId: string, run: () => Promise<void>) => {
    const prev = threadTurns.get(threadId) ?? Promise.resolve();
    const next = (async () => {
      try {
        await prev;
      } catch { /* the previous turn's rejection was already surfaced to its own handler */ }
      await run();
    })();
    threadTurns.set(threadId, next);
    // GC observer: swallow next's rejection HERE only (the handler awaiting
    // `next` still sees it), else the observer chain is an unhandled rejection
    // (cubic review catch, PR #18).
    void (async () => {
      try {
        await next;
      } catch { /* surfaced to the awaiting handler */ }
      if (threadTurns.get(threadId) === next) threadTurns.delete(threadId);
    })();
    return next;
  };

  // both Chat SDK callbacks funnel here. Filter EVERY message, trigger
  // included: an outsider (or our own post) arriving last must not discard
  // relayable home-workspace messages queued behind the turn - the queue hands
  // the handler only the latest message and the rest ride context.skipped
  // (review catch, PR #18).
  const onMessage = async (input: { thread: ServeThread; message: ServeMessage; skipped: ServeMessage[]; isMention: boolean }) => {
    const relayed = [...input.skipped, input.message].filter(relayable).map((m) => ({ text: m.text, authorId: m.author.userId }));
    if (relayed.length === 0) return; // outsider mentions never open a session
    await tracked(serialized(input.thread.id, () => handleTurn({ thread: input.thread, relayed, isMention: input.isMention })));
  };

  /** Deferred-turn wakes: one process-local timer per thread, re-armed by a
   *  later deferral. The durable marker (activeTurn.resumeAt) is the source
   *  of truth - timers die with the process and startup re-arms or recovers
   *  from the record. Node clamps setTimeout delays above 2^31-1ms to 1ms,
   *  so the delay is capped instead: an early fire re-defers off the
   *  still-depleted pool, bounded by resumeCount. */
  const deferredTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleDeferred = (threadId: string, resumeAt: number) => {
    const prev = deferredTimers.get(threadId);
    if (prev !== undefined) clearTimeout(prev);
    log("serve.resume_scheduled", { thread: threadId, resumeAt });
    const timer = setTimeout(() => {
      deferredTimers.delete(threadId);
      if (draining) return;
      try {
        const record = loadSlackThread(threadId);
        if (!record?.activeTurn) return; // superseded: a turn already cleared it
        void tracked(recoverInterrupted(record));
      } catch (e) {
        log("serve.resume_error", { thread: threadId, err: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
      }
    }, Math.min(Math.max(0, resumeAt - Date.now()), 2_147_483_647));
    deferredTimers.set(threadId, timer);
  };

  /** Recover one thread whose activeTurn marker survived: a restart killed
   *  that turn mid-run, or a usage-limit deferral parked it (resumeAt) and
   *  the wake arrived. Notify the thread, then resume the session (or replay
   *  the original prompt when the turn never reached init); past the retry
   *  cap, give up loudly. EVERY branch runs inside the shared per-thread
   *  `serialized` chain and recomputes the decision from a fresh reload
   *  there: an inbound turn (or Slack redelivering the killed turn's unacked
   *  mention) can win the chain first, handle the thread, and clear the
   *  marker - acting on the startup snapshot would then re-run superseded
   *  work and write stale record fields over the session id that turn
   *  persisted (adversarial-review catch). Lives in the seam with
   *  `streamable` INJECTED (the daemon passes its bot-backed handle builder,
   *  tests a fake) so that superseded-recovery race is pinnable
   *  (closing-review catch: the invariant had no test while inline). */
  const recoverInterrupted = async (record: SlackThread) => {
    try {
      const { thread, requesterIds } = await seam.streamable(record.threadId);
      const link = linkForChannel(cfg, bareChannelId(thread.channelId));
      await serialized(record.threadId, async () => {
        // a drain signal can land between the scan and this turn; leave the
        // marker at its previous count so the next start retries.
        if (draining) return;
        const fresh = loadSlackThread(record.threadId);
        const turn = fresh?.activeTurn;
        const decision = fresh ? resumeDecision(fresh) : null;
        if (!fresh || !turn || !decision) return; // superseded: an earlier turn already cleared the marker
        if (turn.resumeAt !== undefined && turn.resumeAt > Date.now()) {
          // a wake that queued behind an in-flight turn can find a RE-DEFERRED
          // marker whose new wake is hours out; resuming it now would post a
          // false "pool has recovered" notice and burn a resume attempt
          // (adversarial-review catch on PR #44). Re-arm and step aside, the
          // same guard the startup scan applies.
          scheduleDeferred(record.threadId, turn.resumeAt);
          return;
        }
        await reapOrphan(turn);
        if (!link) {
          // unlinked since the turn started: nothing can run here; drop the
          // marker and stay silent, like every unlinked-channel path.
          saveSlackThread(omit(fresh, ["activeTurn"]));
          log("serve.resume_unlinked", { thread: record.threadId });
          return;
        }
        if (decision.kind === "give-up") {
          log("serve.resume_gave_up", { thread: record.threadId });
          // post BEFORE clearing, mirroring the resume branch's ordering: a
          // kill or post failure here leaves the marker for the next restart
          // to retry the notice (at-least-once; worst case a duplicate
          // give-up notice), instead of the thread going permanently dark
          // with the user never told the daemon gave up.
          await thread.post(decision.notice);
          saveSlackThread(omit(fresh, ["activeTurn"]));
          return;
        }
        if (turn.resumeAt !== undefined) {
          // the wake arrived, but the reset clock was extrapolated: confirm
          // the pool ACTUALLY recovered before posting the recovery notice
          // and spending one of the capped resume attempts - a still-depleted
          // pool with a KNOWN wake re-defers silently (no quota was spent, so
          // no attempt burns; cursor review catch on PR #44). This runs AFTER
          // the give-up branch on purpose: a turn at the resume cap gives up
          // honestly at its due wake instead of re-deferring forever (cubic
          // review catch). A still-depleted pool with an UNKNOWN wake drops
          // honestly (vercel + cubic review catch: falling through would post
          // a false "pool has recovered" notice and burn an attempt on a
          // spawn-boundary drop) - the drop-beats-false-promise principle
          // stands for the unknown-wake case, and a short silent re-arm loop
          // against a never-recovering pool would keep a zombie promise
          // alive instead. A probe failure falls through to the normal
          // resume, whose own decision path announces honestly.
          try {
            const verdict = await seam.decide();
            const depleted = verdict.reason === "all-depleted" || verdict.reason === "depleted-wait";
            if (depleted) {
              const wake = verdict.waitUntil ?? null;
              if (wake != null) {
                const resumeAt = wake + 5_000;
                saveSlackThread({ ...fresh, activeTurn: { ...turn, resumeAt } });
                scheduleDeferred(record.threadId, resumeAt);
                log("serve.resume_still_depleted", { thread: record.threadId, resumeAt });
                return;
              }
              log("serve.resume_dropped_unknown", { thread: record.threadId });
              await thread.post("the pool is still at its usage limit and its recovery time is now unknown - this held message is dropped; re-send it once the pool recovers.");
              saveSlackThread(omit(fresh, ["activeTurn"]));
              return;
            }
          } catch (e) {
            log("serve.resume_probe_error", { thread: record.threadId, err: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
          }
        }
        log("serve.resume_interrupted", { thread: record.threadId, attempt: decision.marker.resumeCount });
        // the notice posts BEFORE runTurn persists the incremented marker,
        // on purpose: the cap bounds quota-SPENDING attempts (the spawn),
        // and a failed notice spends nothing - the marker survives at its
        // old count for the next restart to retry, at most once per
        // operator-triggered restart, each logged as serve.resume_error.
        // A permanently unpostable channel (bot kicked, archived) therefore
        // retries on every restart; unlinking it clears the marker.
        await thread.post(decision.notice);
        const startedAt = Date.now();
        const outcome = await runTurn({ thread, record: fresh, prompt: decision.prompt, requesterIds, sessionId: decision.sessionId, marker: decision.marker, link });
        await settleTurn({ thread, outcome, startedAt });
      });
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      log("serve.resume_error", { thread: record.threadId, err: detail });
      // a DEFERRED turn's wake must survive a transient failure here (a
      // Slack hiccup at an unattended 4am wake would otherwise strand the
      // held turn until the next restart - adversarial-review catch on
      // PR #44): re-arm a short retry while the marker still defers. The
      // marker-clearing paths (resume, supersession, unlink, give-up) all
      // end the loop; killed-turn (no resumeAt) startup semantics keep
      // their once-per-restart retry.
      try {
        const marker = loadSlackThread(record.threadId)?.activeTurn;
        if (marker?.resumeAt !== undefined && !draining) scheduleDeferred(record.threadId, Date.now() + RESUME_RETRY_MS);
      } catch {
        // the record itself is unreadable; the startup scan is the backstop.
      }
    }
  };

  return {
    /** in-flight turn promises; shutdown drains them. */
    activeTurns,
    isDraining: () => draining,
    /** stop taking new turns and wake parked/retrying ones. Pending deferred
     *  wakes are cancelled: the markers are durable and the next generation
     *  re-arms them at startup. */
    beginDrain: () => {
      draining = true;
      drainAbort.abort();
      for (const timer of deferredTimers.values()) clearTimeout(timer);
      deferredTimers.clear();
    },
    relayable,
    onMessage,
    /** the pieces runDaemon's startup interrupted-turn recovery reuses, so a
     *  resumed turn shares the exact chain and marker machinery of an inbound
     *  one. */
    serialized,
    tracked,
    runTurn,
    settleTurn,
    recoverInterrupted,
    scheduleDeferred,
  };
}

async function runDaemon(): Promise<number> {
  let cfg = loadSlackConfig();
  if (!cfg) {
    printSetupInstructions();
    return 1;
  }
  if (cfg.links.length === 0) {
    console.error(c.red("no channel links - run `tokenmaxxing serve link <channel-id> <repo>` first"));
    return 1;
  }
  // the external-author guard compares every message's origin against the home
  // workspace. The reference is re-captured from the live token at EVERY start
  // (a stale persisted id would fail-closed reject the owner's own messages);
  // a failed capture fails the daemon fast - the guard never runs
  // reference-less, and the daemon is useless without Slack reachable anyway.
  const workspaceTeamId = await fetchWorkspaceTeamId({ botToken: cfg.botToken });
  if (cfg.workspaceTeamId !== workspaceTeamId) {
    cfg = { ...cfg, workspaceTeamId };
    saveSlackConfig(cfg);
    log("serve.team_captured", { team: workspaceTeamId });
  }

  // every log() event from here on (serve.* plus the in-process swap/decision
  // events fired by ensureBestAccount/stopHookCheck) also prints to the
  // terminal, so a foreground `xx serve` shows what it is doing live.
  setLogEcho({ printer: (entry) => console.log(formatLogLine(entry)) });

  // single-instance guard, held for the process lifetime (the fd releases on
  // exit): without it a replacement daemon can start inside the previous
  // generation's drain window, read a still-RUNNING turn's activeTurn marker,
  // and resume it - two claude processes in one cwd (adversarial-review
  // catch). Blocking here makes a rolling restart wait out the drain instead.
  console.log(c.dim("acquiring the serve singleton lock (waits for a draining daemon to exit)"));
  await acquireLock(paths.serveLockFile);

  const slack = createSlackAdapter({
    mode: "socket",
    botToken: cfg.botToken,
    appToken: cfg.appToken,
    // Native append-streaming (chat.startStream) with task cards is the
    // correct mode (user-confirmed live 2026-07-18): it works in channel
    // threads even when auth.test reports no assistant:write, so never gate
    // it on a scope probe. The adapter falls back to post-and-edit by itself
    // when a workspace truly rejects streaming. agentView matches the
    // manifest's Agent messaging experience for the DM surface.
    agentView: true,
    // the web-api default retry policy (tenRetriesInAboutThirtyMinutes) can
    // stall a streamed turn ~30min on one rate-limited edit; this is
    // @slack/web-api's fiveRetriesInFiveMinutes literal (dep not declared,
    // so the values are inlined).
    webClientOptions: { retryConfig: { retries: 5, factor: 3.86 }, timeout: 15_000 },
  });
  // held directly (not only via Chat) so startup can re-subscribe recorded
  // threads: subscriptions live in this in-memory state and die with the
  // process, and only a fresh mention would otherwise revive a thread.
  const state = createMemoryState();
  const bot = new Chat({
    userName: "tokenmaxxing",
    adapters: { slack },
    state,
    // per-thread lock with queueing: a message landing mid-turn waits its turn
    // instead of racing a second claude spawn on the same cwd. Queue-entry TTL
    // expiry is SILENT (chat 4.34.0 has no app callback for it), so the TTL
    // must outlast the longest legitimate hold: a depleted-pool park
    // (PARK_MAX_MS 14min) plus a long claude turn. Expired-and-folded beats
    // silently-vanished, hence a full hour. maxQueueSize matters for the same
    // reason: the SDK default is 10 with a LOG-LESS drop-oldest trim
    // (@chat-adapter/state-memory enqueue splices the front, and the SDK's
    // message-dropped log only fires for drop-newest), so a >10-message burst
    // behind one long turn silently ate the oldest instructions
    // (adversarial-review catch). 100 outlasts any legitimate burst; the TTL
    // stays the real bound.
    concurrency: { strategy: "queue", queueEntryTtlMs: 3_600_000, maxQueueSize: 100 },
    // without this a cards-only segment in post-and-edit fallback would
    // strand a bare "..." placeholder message.
    fallbackStreamingPlaceholderText: null,
    logger: "warn",
  });

  // the message-handling runtime (author guard, folding, per-thread
  // serialization, activeTurn markers, drain drops, finish close-out) lives
  // in buildServeRuntime so tests can drive the real wiring; production deps
  // go in here.
  const runtime = buildServeRuntime({
    cfg,
    workspaceTeamId,
    botUserId: () => slack.botUserId ?? null,
    relay: relayThread,
    cleanup: cleanupThread,
    // lazy on purpose: streamableThread is declared just below and only ever
    // invoked long after startup (recovery runs and deferred wakes).
    streamable: (threadId) => streamableThread(threadId),
    decide: ensureBestAccount,
  });

  /** A proactive thread handle that can still stream natively. bot.thread()
   *  carries no currentMessage, and without one handleStream has no
   *  recipientUserId/recipientTeamId, so the Slack adapter's stream() gate
   *  falls back to card-less post-and-edit that also strands a blank message
   *  per card-only segment (verified in chat 4.34.0 + @chat-adapter/slack).
   *  Reusing the newest human message in the thread as currentMessage
   *  restores the exact context an inbound turn would have, and its author is
   *  the natural requester to tag on a resumed turn. The explicit ThreadImpl
   *  constructor (published typed API) is deliberate over the prose-documented
   *  ThreadImpl.fromJSON/reviver restore path: fromJSON takes the lazy config
   *  branch, which silently reverts fallbackStreamingPlaceholderText to "..."
   *  (re-stranding the placeholder this daemon suppresses) and needs
   *  registerSingleton for state. */
  const streamableThread = async (threadId: string) => {
    const handle = bot.thread(threadId);
    for await (const message of handle.messages) {
      if (runtime.relayable(message)) {
        const thread = new ThreadImpl({
          adapter: slack,
          stateAdapter: state,
          channelId: handle.channelId,
          id: threadId,
          isDM: false,
          currentMessage: message,
          fallbackStreamingPlaceholderText: null,
        });
        return { thread, requesterIds: [message.author.userId] };
      }
    }
    // no human message on record: card-less is all there is
    return { thread: handle, requesterIds: [] };
  };

  bot.onNewMention(async (thread, message, context) => runtime.onMessage({ thread, message, skipped: context?.skipped ?? [], isMention: true }));
  bot.onSubscribedMessage(async (thread, message, context) => runtime.onMessage({ thread, message, skipped: context?.skipped ?? [], isMention: false }));

  // drain instead of dying mid-answer: stop taking new turns, let in-flight
  // ones finish (bounded - a hung claude turn must not block a restart
  // forever), then disconnect. A second signal forces an immediate exit.
  // Registered BEFORE initialize() (post-0.19.1 review catch): the socket
  // goes live inside initialize, so a turn could start while runDaemon was
  // still suspended there and a signal in that window hit default
  // disposition - an instant kill with no drain.
  const DRAIN_MS = 300_000;
  const shutdown = async (signal: string) => {
    if (runtime.isDraining()) {
      log("serve.forced_exit", { signal });
      process.exit(1);
    }
    runtime.beginDrain(); // parked/retrying turns wake, post their drop notice, and finish
    log("serve.draining", { signal, turns: runtime.activeTurns.size });
    console.log(`${c.yellow("●")} ${signal}: draining ${count({ n: runtime.activeTurns.size, noun: "in-flight turn" })} (again to force)`);
    // re-snapshot until stable inside the deadline: drain-window drop notices
    // join activeTurns after the first snapshot and must still flush.
    const deadline = Date.now() + DRAIN_MS;
    while (runtime.activeTurns.size > 0 && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...runtime.activeTurns]), delay(deadline - Date.now())]);
    }
    try {
      await bot.shutdown();
    } catch (e) {
      // exit must be reached even when the socket teardown rejects; the
      // second-signal force path must not be the only escape.
      log("serve.shutdown_error", { err: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
    log("serve.stopped", { dropped: runtime.activeTurns.size });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // closing the foreground terminal sends SIGHUP, whose default disposition
  // kills the daemon WITHOUT the "exit" event - so the process-exit hook that
  // kill-groups the DETACHED claude child never runs, the child survives as
  // an orphan still mutating the cwd, and the freed serve-lock lets the next
  // generation resume the same session beside it (adversarial-review catch,
  // exit-skip verified empirically on Bun; a mid-turn orphan does NOT die on
  // its dead stdout pipe - also verified - which is why the reaper exists).
  // Draining instead keeps the child owned; its Slack streaming needs no
  // tty, so the turn can even finish. A SIGKILL/crash orphan is covered by
  // reapOrphan via the marker's pid identity; the only unmarked window is
  // spawn-to-persist, both inside the spawn hook BEFORE the SDK writes the
  // prompt, and a prompt-less orphan exits on its dead stdin's EOF (verified
  // against the real claude binary in the SDK's exact stdio shape: dead in
  // 2s, zero API calls).
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  // initialize() starts the PERSISTENT Socket Mode client (auto-reconnecting)
  // wired straight into event routing; the daemon only has to stay alive.
  // Never call startSocketModeListener here: that is the serverless leased
  // variant (it demands options.waitUntil and returns instantly without it),
  // and awaiting it in a loop starved the event loop so hard the WebSocket
  // never delivered a single event (live incident 2026-07-18).
  await bot.initialize();

  // subscriptions live in the memory state and died with the previous daemon;
  // the durable slack-threads/ records say which threads are ours, so restore
  // routing for them (message routing checks stateAdapter.isSubscribed,
  // verified in chat 4.34.0). Without this a restart leaves every open thread
  // deaf to non-mention follow-ups.
  const records = listSlackThreads();
  for (const record of records) await state.subscribe(record.threadId);
  log("serve.resubscribed", { threads: records.length });

  // threads whose activeTurn marker survived the previous daemon were either
  // killed mid-turn by a restart (live incident 2026-07-18: a redeploy
  // silently killed a ship turn 8 minutes in and the thread just went dark)
  // or deferred at a usage limit (resumeAt; 2026-07-20 incident: dropped
  // messages sat dead for hours after the pool recovered). A future resumeAt
  // re-arms its timer; everything else recovers now, tracked so a drain
  // waits for it; the actionable decision is recomputed under the per-thread
  // lock inside.
  for (const record of records) {
    const marker = record.activeTurn;
    if (!marker) continue;
    if (marker.resumeAt !== undefined && marker.resumeAt > Date.now()) {
      runtime.scheduleDeferred(record.threadId, marker.resumeAt);
      continue;
    }
    void runtime.tracked(runtime.recoverInterrupted(record));
  }

  console.log(`${c.green("●")} serving ${count({ n: cfg.links.length, noun: "linked channel" })} over Slack Socket Mode - mention the bot in a linked channel to open a session (Ctrl-C to stop)`);
  log("serve.started", { links: cfg.links.length });
  await new Promise<never>(() => {});
  return 0;
}

export async function cmdServe(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined: return runDaemon();
    case "setup": return cmdServeSetup();
    case "link": return cmdServeLink(rest);
    case "unlink": return cmdServeUnlink(rest[0]);
    case "links": return cmdServeLinks();
    default:
      console.error(SERVE_USAGE);
      return 2;
  }
}
