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

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { delay, omit, uniq } from "es-toolkit";
import { z } from "zod";
import { Chat, ConsoleLogger, StreamingPlan, ThreadImpl, type StreamChunk } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { MemoryStateAdapter } from "@chat-adapter/state-memory";
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
  SlackThreadSchema,
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
 *  with "Must provide an object". reactions:write powers the status reactions
 *  the daemon sets on triggering messages; reactions:read + the reaction_added
 *  event feed user reactions back in (matching @chat-adapter/slack's own
 *  README manifest). Changing scopes on an existing app requires reinstalling
 *  it to the workspace. */
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
      - reactions:read
      - reactions:write
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
      - reaction_added
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

/** The slice of a Chat SDK message the author guard + folding read. id is the
 *  Slack message ts (verified in @chat-adapter/slack 4.34.0: Message.id =
 *  event.ts, exactly what reactions.add takes as timestamp), so it is the
 *  handle status reactions attach to. */
const ServeMessageSchema = z.custom<{
  id: string;
  text: string;
  author: { userId: string; isMe: boolean; isBot?: boolean | "unknown" };
  raw?: unknown;
}>();
type ServeMessage = z.infer<typeof ServeMessageSchema>;

/** Status reactions on the triggering message: hourglass while the turn runs,
 *  then exactly one terminal state. Color-of-the-moment for the whole thread
 *  list: which asks are being worked, which wait on the user, which are done. */
const STATUS_EMOJI = {
  processing: "hourglass_flowing_sand",
  done: "white_check_mark",
  failed: "x",
  attention: "question",
} as const;

/** One nudge per ask, this long after the asking turn settled: enough for a
 *  present user to answer on their own, short enough that a blocked thread
 *  does not sit forgotten. */
export const ATTENTION_NUDGE_MS = 600_000;
/** How often the daemon sweeps for overdue attention (runDaemon interval). */
export const NUDGE_SWEEP_MS = 60_000;

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
    /** steering seam (see relayThread): a live attempt's steer function, or
     *  null when the attempt ends. steer runs its onAccept callback
     *  synchronously inside acceptance, before the child sees the text. */
    onSteer?: (steer: ((text: string, onAccept?: () => void) => boolean) | null) => void;
  }) => Promise<TurnOutcome>;
  cleanup: (input: { threadId: string }) => CleanupOutcome;
  /** add/remove a status reaction on a message (production: the Slack
   *  adapter's reactions.add/remove). Callers never let a rejection escape:
   *  a missing scope or an already_reacted must not fail a turn. */
  react: (input: { threadId: string; messageId: string; emoji: string; op: "add" | "remove" }) => Promise<void>;
  /** post one standalone text message into a thread by id (production:
   *  bot.thread(threadId).post) - the nudge path, which runs outside any
   *  turn and needs no streaming. */
  postToThread: (input: { threadId: string; text: string }) => Promise<void>;
  /** does this user belong to the home workspace? Reaction events carry no
   *  team-origin fields, so the note path verifies reactors through this
   *  (production: users.info, cached). null = unverifiable = fail closed. */
  isHomeUser: (input: { userId: string }) => Promise<boolean | null>;
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
  // channels already diagnosed as unlinked this run (see handleTurn).
  const unlinkedLogged = new Set<string>();
  // corrupt thread records already logged as skipped this run (see nudgeSweep).
  const sweepSkipLogged = new Set<string>();
  // Steering registry: one acceptor per thread with a LIVE query attempt
  // (registered by runTurn via the relay's onSteer hook, removed when the
  // attempt ends). onMessage tries the acceptor before the inbox - steering
  // is the default for a mid-turn reply (owner decision 2026-07-27); a
  // refusal (attempt ending, mention-only text, out-of-order arrival) falls
  // back to the inbox path. A thread only ever appears here after handleTurn
  // ran under this daemon's cfg, so the channel is known linked.
  const liveSteers = new Map<string, (m: { relayed: { text: string; authorId: string; id: string }[] }) => Promise<boolean>>();
  // TURN-PRODUCING serialized work per thread (running plus waiting). Only
  // turn producers count (adversarial-review catch: reaction notes and nudge
  // bookkeeping ride the same serialized chain, and counting them silently
  // disabled steering for the rest of any turn a user reacted to). A steer
  // is only ordered when nothing waits behind the live turn.
  const turnDepth = new Map<string, number>();
  // Un-steered messages waiting for the next turn, folded and drained as ONE
  // turn (sorted by Slack ts, which restores order for any upstream arrival
  // race). This is the daemon-owned replacement for the chat queue's
  // skipped-message folding. Each entry carries its delivery's mention flag,
  // so the drained turn derives mention-ness from the RETAINED messages - a
  // mention dropped by the overflow cap must not leave a phantom flag behind
  // (cubic review catch on PR #50).
  const pendingInbox = new Map<string, { text: string; authorId: string; id: string; isMention: boolean }[]>();
  // Per-thread arrival ordering: the steer attempt and the inbox push for
  // one message run to completion before the next message's do, so two
  // near-simultaneous replies can never interleave at the acceptor's await
  // points and land on the child's stdin out of order.
  const arrivalChains = new Map<string, Promise<void>>();

  /** Best-effort status reaction: reaction state is decoration, so every
   *  failure (missing reactions:write until the app is reinstalled,
   *  already_reacted, no_reaction on remove) is log-only and can never fail
   *  the turn it annotates. */
  const setStatus = async (input: { threadId: string; messageId: string; emoji: string; op: "add" | "remove" }) => {
    try {
      await seam.react(input);
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      log("serve.reaction_error", { thread: input.threadId, emoji: input.emoji, op: input.op, err: detail });
    }
  };

  /** One relayed turn with the durable activeTurn marker around it: written
   *  before the spawn, cleared when the turn returns, so a marker surviving
   *  into the next daemon start identifies a turn a restart killed mid-run.
   *  The session id persists the moment init assigns it - a first-turn kill
   *  must stay resumable. Returns the steered message ids alongside the
   *  outcome: they joined the turn mid-run, so the caller's settle must
   *  close their reaction lifecycle too. */
  const runTurn = async (input: {
    thread: { id: string; post: (m: StreamingPlan) => Promise<unknown> };
    record: SlackThread;
    prompt: string;
    requesterIds: string[];
    sessionId: string | null;
    marker: ActiveTurn;
    link: SlackLink;
  }): Promise<{ outcome: TurnOutcome; steeredMessageIds: string[] }> => {
    let record: SlackThread = { ...input.record, activeTurn: input.marker };
    saveSlackThread(record);
    // the whole turn (parks and retries included) reads as "being processed";
    // a resumed marker's steered messages re-arm their hourglass too
    // (setStatus swallows already_reacted).
    for (const id of [input.marker.messageId, ...(input.marker.steeredMessageIds ?? [])]) {
      if (id) await setStatus({ threadId: input.thread.id, messageId: id, emoji: STATUS_EMOJI.processing, op: "add" });
    }
    let outcome: TurnOutcome | null = null;
    let steeredMessageIds = input.marker.steeredMessageIds ?? [];
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
          // one, and an identity-less pid is never signaled. Built on the
          // CURRENT marker (a steer may have grown it), with the previous
          // spawn's identity dropped: a retry child must never inherit the
          // dead child's lstart, or the reaper would skip (or mis-verify)
          // the live group.
          const startedAt = pidStartTime(pid);
          const marker = omit(record.activeTurn ?? input.marker, ["pid", "pidStartedAt"]);
          record = { ...record, activeTurn: { ...marker, pid, ...(startedAt === null ? {} : { pidStartedAt: startedAt }) } };
          saveSlackThread(record);
        },
        onSessionId: (sessionId) => {
          record = { ...record, sessionId };
          saveSlackThread(record);
        },
        drainSignal: drainAbort.signal,
        // While an attempt is steerable, a relayable mid-turn message folds
        // into the RUNNING turn (owner decision 2026-07-27: steering is the
        // default; the queued next turn is only the fallback). The acceptor
        // runs its marker mutation synchronously after a successful steer:
        // the steered text becomes part of the durable prompt (replays and
        // retries must include it) before any await can interleave with the
        // turn's own marker writes.
        onSteer: (steerText) => {
          if (steerText === null) {
            liveSteers.delete(input.thread.id);
            return;
          }
          liveSteers.set(input.thread.id, async (m) => {
            const stripped = m.relayed
              .map((r) => ({ text: stripLeadingMention({ text: r.text, botUserId: seam.botUserId() }), authorId: r.authorId, id: r.id }))
              .filter((r) => r.text !== "");
            if (stripped.length === 0) return false;
            // out-of-order insurance: Slack ids are timestamps, so a message
            // OLDER than anything this turn already carries arrived late
            // through an upstream race - refuse it into the inbox, whose
            // drain sorts by ts, instead of folding it after its successor.
            const seen = record.activeTurn ?? input.marker;
            const newestSeen = Math.max(Number(seen.messageId ?? 0) || 0, ...(seen.steeredMessageIds ?? []).map((id) => Number(id) || 0));
            if (stripped.some((r) => (Number(r.id) || 0) < newestSeen)) return false;
            // per-turn steer budget (cursor security review, round 2 on
            // PR #50): accepted steers grow the durable prompt and the
            // child's queue outside the inbox's 100-entry cap, so a flood
            // could balloon one turn without bound. Far past any human
            // steering cadence, a reply takes the capped inbox path instead.
            if ((seen.steeredMessageIds?.length ?? 0) + stripped.length > 25) return false;
            // hourglass BEFORE the steer so a settle racing this acceptor
            // can never leave an unremovable reaction; a refusal takes it
            // back off.
            for (const r of stripped) {
              await setStatus({ threadId: input.thread.id, messageId: r.id, emoji: STATUS_EMOJI.processing, op: "add" });
            }
            // authors the turn does not know yet get named inline: the
            // UserPromptSubmit context does not re-fire for folded mid-turn
            // messages, so attribution rides the message itself.
            const text = stripped
              .map((r) => (input.requesterIds.includes(r.authorId) ? r.text : `Message from <@${r.authorId}>:\n${r.text}`))
              .join("\n\n");
            // The durable commit runs INSIDE steer's acceptance, in the same
            // JS tick as its liveness check (adversarial-review catch, round
            // 3: this acceptor runs on the arrival chain and can resume from
            // its hourglass awaits AFTER the turn ended - a write-ahead save
            // here resurrected the finished turn's marker on disk, and its
            // refusal rollback clobbered post-turn state with a stale
            // snapshot). Acceptance proves the turn is live, so the closure
            // record is disk-faithful; the marker still grows durably BEFORE
            // the text reaches the child's stdin (a crash in between replays
            // a steer the child may never have seen - duplication over
            // loss); and a refusal commits nothing, so a stale invocation is
            // a harmless fall-through to the inbox.
            let asked: SlackThread["attention"];
            const commit = () => {
              const mergedRequesters = uniq([...input.requesterIds, ...stripped.map((r) => r.authorId)]);
              const marker = record.activeTurn ?? input.marker;
              const grownIds = [...(marker.steeredMessageIds ?? []), ...stripped.map((r) => r.id)];
              let next = { ...record, activeTurn: { ...marker, prompt: `${marker.prompt}\n\n${text}`, requesterIds: mergedRequesters, steeredMessageIds: grownIds } };
              // the user responded: a pending ask is answered by the steer
              // just like by a queued turn (adversarial-review catch:
              // leaving it would strand the question mark and fire a
              // spurious nudge about an ask this very message answered).
              const pendingAsk = next.attention;
              if (pendingAsk) next = omit(next, ["attention"]);
              // all-or-nothing (cubic review catch, round 4): the durable
              // save runs before ANY outer mutation, so a failed write
              // leaves the turn's view untouched and the refusal fallback
              // below starts from clean state - without this ordering the
              // settle would stamp the never-delivered message with the
              // turn's outcome emoji.
              saveSlackThread(next);
              steeredMessageIds = grownIds;
              record = next;
              asked = pendingAsk;
              for (const r of stripped) {
                if (!input.requesterIds.includes(r.authorId)) input.requesterIds.push(r.authorId);
              }
            };
            // a throwing commit (the durable save failing) escapes steer()
            // BEFORE the text reaches the child or the relay records it
            // (cubic review catch, round 4): treat it as a refusal, so the
            // message keeps its inbox fallback instead of vanishing into
            // the generic task_crashed log with its hourglass stranded. If
            // the disk stays broken, the inbox turn's own marker write
            // surfaces it loudly through the crash-notice path.
            let accepted = false;
            try {
              accepted = steerText(text, commit);
            } catch (e) {
              log("serve.steer_commit_failed", { thread: input.thread.id, err: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
            }
            if (!accepted) {
              for (const r of stripped) {
                await setStatus({ threadId: input.thread.id, messageId: r.id, emoji: STATUS_EMOJI.processing, op: "remove" });
              }
              return false;
            }
            log("serve.steered", { thread: input.thread.id, texts: stripped.length });
            if (asked?.messageId) {
              await setStatus({ threadId: input.thread.id, messageId: asked.messageId, emoji: STATUS_EMOJI.attention, op: "remove" });
            }
            return true;
          });
        },
      });
      record = { ...record, sessionId: outcome.sessionId };
      return { outcome, steeredMessageIds };
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
      // belt-and-braces: the relay clears its steer hook per attempt, but the
      // registry entry must never outlive the turn that owns it.
      liveSteers.delete(input.thread.id);
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
    /** every relayed message this turn (the inbox batch, ts-sorted), text
     *  paired with its author id: a decision may be owed to an earlier
     *  folded sender, and a sender whose whole message was the bot mention
     *  contributes no prompt text, so text and author filter together
     *  (review catches 2026-07-18). id is the Slack message ts; the LAST
     *  entry (the triggering relayable message) carries the status
     *  reactions. */
    relayed: { text: string; authorId: string; id: string }[];
    isMention: boolean;
  }) => {
    const { thread, isMention } = input;
    const link = linkForChannel(cfg, bareChannelId(thread.channelId));
    if (!link) {
      // checked BEFORE the draining branch: unlinked channels are
      // contractually log-only silent, and a drain-window drop notice posted
      // into one would tell a user to resend a message that will never be
      // served (closing-review catch). Logged once per channel per daemon run:
      // with several daemons sharing one Slack app this fires on every
      // load-balanced envelope for a sibling's channel (live incident
      // 2026-07-20), and the diagnosis needs one line, not a stream.
      if (!unlinkedLogged.has(thread.channelId)) {
        unlinkedLogged.add(thread.channelId);
        log("serve.unlinked_channel", {
          channel: thread.channelId,
          note: "not linked on this host; if another tokenmaxxing serve shares this Slack app, Slack delivers each socket event to only ONE of them and thread replies get lost - give every daemon its own Slack app",
        });
      }
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
    // relayed carries every message the inbox batched for this turn, folded
    // into one prompt here. A message that is empty once its bot mention is
    // stripped contributes neither prompt text nor a requester id (cursor
    // review catch 2026-07-18).
    const stripped = input.relayed
      .map((m) => ({ text: stripLeadingMention({ text: m.text, botUserId: seam.botUserId() }), authorId: m.authorId }))
      .filter((m) => m.text !== "");
    let prompt = stripped.map((m) => m.text).join("\n\n");
    const requesterIds = uniq(stripped.map((m) => m.authorId));
    // the triggering message (the last relayable one), even when its own text
    // was just the bot mention: the status reactions belong on the message
    // the user watched the bot pick up.
    const messageId = input.relayed.at(-1)?.id;
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
    // a taken-over deferral's messages still wear their processing hourglass
    // (a deferral settles nothing); this turn serves their held prompt, so
    // it adopts their ids and settles them with its own outcome - without
    // the adoption the old trigger's hourglass would read "processing"
    // forever once the fold replaced its marker.
    const adoptedIds = deferred ? [...(deferred.messageId ? [deferred.messageId] : []), ...(deferred.steeredMessageIds ?? [])] : [];
    if (deferred) {
      const timer = deferredTimers.get(thread.id);
      if (timer !== undefined) clearTimeout(timer);
      deferredTimers.delete(thread.id);
      prompt = `${deferred.prompt}\n\n${prompt}`;
      log("serve.deferred_folded", { thread: thread.id });
    }
    // the user responded: the thread is no longer waiting on them. Clear the
    // attention state and its question-mark reaction before the new turn
    // runs, so a due nudge can never fire about an ask that just got its
    // answer.
    if (record.attention) {
      const asked = record.attention;
      record = omit(record, ["attention"]);
      saveSlackThread(record);
      if (asked.messageId) {
        await setStatus({ threadId: thread.id, messageId: asked.messageId, emoji: STATUS_EMOJI.attention, op: "remove" });
      }
    }
    // reactions observed since the last turn ride into this prompt as
    // context, then clear: the model sees them without any metered
    // reaction-triggered turn.
    if (record.pendingReactions && record.pendingReactions.length > 0) {
      const notes = record.pendingReactions
        .map((r) => `<@${r.userId}> reacted :${r.emoji}: in this thread.`)
        .join("\n");
      prompt = `${prompt}\n\nSlack reactions since your last turn:\n${notes}`;
      record = omit(record, ["pendingReactions"]);
      saveSlackThread(record);
    }
    // subscriptions live in the memory state, so a daemon restart forgets
    // them; every mention re-subscribes to keep follow-up replies flowing.
    if (isMention) await thread.subscribe();
    // "is working..." assistant status; a no-op until the Slack app has the
    // agent feature + assistant:write (the adapter warns instead of throwing).
    await thread.startTyping();
    const startedAt = Date.now();
    const { outcome, steeredMessageIds } = await runTurn({
      thread,
      record,
      prompt,
      requesterIds,
      sessionId: record.sessionId,
      marker: { prompt, startedAt: new Date().toISOString(), resumeCount: 0, ...(messageId ? { messageId } : {}), requesterIds, ...(adoptedIds.length > 0 ? { steeredMessageIds: adoptedIds } : {}) },
      link,
    });
    await settleTurn({ thread, outcome, startedAt, messageId, steeredMessageIds, requesterIds });
  };

  /** Post-turn bookkeeping shared by inbound and resumed turns: the outcome
   *  log line, the status-reaction settle, the attention marking when the
   *  model asked the user, and the finish_thread garbage collection. Never
   *  throws into the caller - the daemon must keep serving. */
  const settleTurn = async (input: {
    thread: { id: string; post: (m: string | AsyncIterable<string | StreamChunk>) => Promise<unknown>; unsubscribe: () => Promise<void> };
    outcome: TurnOutcome;
    startedAt: number;
    /** the triggering message carrying the status reactions; absent = skip. */
    messageId?: string;
    /** messages steered into the turn mid-run: they carry the same reaction
     *  lifecycle as the trigger and settle with the same emoji. */
    steeredMessageIds?: string[];
    /** the turn's asked users, persisted when the model flagged attention. */
    requesterIds?: string[];
  }) => {
    const { thread, outcome, startedAt } = input;
    log(outcome.deferUntil !== null ? "serve.turn_deferred" : outcome.failed ? "serve.turn_failed" : "serve.turn_done", {
      thread: thread.id,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      ...(outcome.deferUntil === null ? {} : { resumeAt: outcome.deferUntil }),
    });
    // settle the status reaction: failed beats attention beats done (a failed
    // ask never reads as a clean question mark), then drop the hourglass.
    // Three review-caught exceptions: a drain-presumed-killed turn (same
    // predicate as runTurn's marker retention) keeps its hourglass - it will
    // auto-resume next start, and a terminal x nothing ever removes would
    // read a later successful resume as failed; a usage-limit DEFERRAL is
    // the other auto-resume case and keeps its hourglass for the identical
    // reason (cursor + vercel review catch on PR #43: the durable marker
    // promises a resume, so the triggering message must not read as failed
    // for the whole deferral); and a finished thread settles as done even
    // when the model also flagged attention, because the record deletion
    // below makes the question mark unremovable forever.
    const killedByDrain = draining && outcome.failed && !outcome.announcedDrop && !outcome.resultReceived;
    const deferredForResume = outcome.deferUntil !== null;
    if (!killedByDrain && !deferredForResume) {
      const emoji = outcome.failed ? STATUS_EMOJI.failed : outcome.attention && !outcome.finish ? STATUS_EMOJI.attention : STATUS_EMOJI.done;
      // steerLost: a steered follow-up's own drained turn failed after the
      // primary turn succeeded, so the steered messages settle as failed -
      // matching the in-thread re-send notice; a lost instruction must never
      // read green (see TurnOutcomeSchema.steerLost for the per-turn
      // attribution tradeoff).
      const steeredEmoji = outcome.steerLost ? STATUS_EMOJI.failed : emoji;
      for (const id of [input.messageId, ...(input.steeredMessageIds ?? [])]) {
        if (!id) continue;
        await setStatus({ threadId: thread.id, messageId: id, emoji: id === input.messageId ? emoji : steeredEmoji, op: "add" });
        await setStatus({ threadId: thread.id, messageId: id, emoji: STATUS_EMOJI.processing, op: "remove" });
      }
    }
    // the model asked the user for a decision: mark the thread waiting so the
    // nudge sweep and the reaction-answer path can see it. Persisted even on
    // a failed turn (the ask may have streamed before the failure; a spurious
    // nudge beats a silently forgotten ask). Skipped on finish: the record is
    // about to be deleted.
    if (outcome.attention && !outcome.finish) {
      const fresh = loadSlackThread(thread.id);
      if (fresh) {
        saveSlackThread({
          ...fresh,
          attention: {
            requesterIds: input.requesterIds ?? [],
            askedAt: new Date().toISOString(),
            ...(input.messageId ? { messageId: input.messageId } : {}),
          },
        });
        log("serve.attention_marked", { thread: thread.id });
      }
    }
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

  /** The ownership funnel for every task the daemon spawns: registration in
   *  activeTurns so a shutdown drains it, and the daemon's terminal error
   *  boundary. Bun kills the WHOLE process on any unhandled rejection
   *  (default-mode exit verified 2026-07-27), so a `void tracked(...)`
   *  fire-and-forget whose task threw would otherwise take every concurrent
   *  session's turn down with it - one thread's bad state file must never
   *  end another thread's half-streamed answer. Site-specific handling (the
   *  in-thread crash notice in onMessage) stays at the site that has the
   *  context; whatever escapes lands here, logged, and the daemon keeps
   *  serving. */
  const tracked = async (turn: Promise<void>) => {
    activeTurns.add(turn);
    try {
      await turn;
    } catch (e) {
      log("serve.task_crashed", { err: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    } finally {
      activeTurns.delete(turn);
    }
  };

  // Per-thread serialization owned HERE: with concurrent dispatch (see
  // runDaemon's Chat config) chat provides no per-thread locking at all, so
  // this chain is the ONLY thing keeping two claude turns off one thread's
  // cwd and session. It predates the concurrent switch for the same reason
  // in weaker form: chat's old queue lock expired 30s into any claude turn
  // and let a second handler start anyway (review catch, PR #18).
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
  /** serialized + the turnDepth count, for callers that produce a claude
   *  TURN (inbox drains, reaction answers, recoveries). Bookkeeping riders
   *  on the chain (reaction notes, nudges) use bare `serialized` so they
   *  never gate steering. */
  const serializedTurn = (threadId: string, run: () => Promise<void>) => {
    turnDepth.set(threadId, (turnDepth.get(threadId) ?? 0) + 1);
    const next = serialized(threadId, run);
    void next.catch(() => {}).finally(() => {
      const depth = (turnDepth.get(threadId) ?? 1) - 1;
      if (depth <= 0) turnDepth.delete(threadId);
      else turnDepth.set(threadId, depth);
    });
    return next;
  };

  // both Chat SDK callbacks funnel here. Filter EVERY message, trigger
  // included: an outsider (or our own post) arriving last must not discard
  // relayable home-workspace messages delivered alongside it (review catch,
  // PR #18). context.skipped is empty under concurrent dispatch but stays
  // merged defensively - a chat release reintroducing batching must not
  // silently drop messages.
  const onMessage = async (input: { thread: ServeThread; message: ServeMessage; skipped: ServeMessage[]; isMention: boolean }) => {
    const relayed = [...input.skipped, input.message].filter(relayable).map((m) => ({ text: m.text, authorId: m.author.userId, id: m.id }));
    if (relayed.length === 0) return; // outsider mentions never open a session
    // arrivals for one thread DECIDE strictly one at a time, in delivery
    // order: the steer-or-inbox decision for this message completes before
    // the next message's begins, so two near-simultaneous replies can never
    // interleave at the acceptor's await points. The chain holds only the
    // DECISION - a scheduled turn's completion is awaited outside it, or a
    // long turn would hold every later arrival hostage and steering could
    // never engage.
    const prev = arrivalChains.get(input.thread.id) ?? Promise.resolve();
    const job = (async () => {
      try {
        await prev;
      } catch { /* the previous arrival's failure was surfaced to its own caller */ }
      return dispatchArrival({ thread: input.thread, relayed, isMention: input.isMention });
    })();
    const link = job.then(
      () => {},
      () => {},
    );
    arrivalChains.set(input.thread.id, link);
    void link.then(() => {
      if (arrivalChains.get(input.thread.id) === link) arrivalChains.delete(input.thread.id);
    });
    // tracked from the DECISION on (codex review catch on PR #50): the drain
    // waits on activeTurns, and an arrival still deciding at shutdown lived
    // nowhere else - the daemon could exit before the message reached the
    // inbox, a marker, or the drop notice.
    await tracked((async () => {
      const scheduled = await job;
      if (scheduled) await scheduled.turn;
    })());
  };

  /** One message's steer-or-inbox decision. Steering first (owner decision
   *  2026-07-27): a reply landing while the thread's turn is running folds
   *  into that turn instead of waiting behind it. Guarded to an empty inbox
   *  and no waiting turn, or the fold would reorder this message ahead of
   *  one already waiting; a drain keeps its loud-drop contract. Every
   *  refusal falls through to the inbox, whose drain runs ALL waiting
   *  messages as one folded turn - the daemon-owned replacement for the
   *  chat queue's skipped-message folding, sorted by Slack ts so an
   *  upstream arrival race cannot reorder the prompt. Returns the tracked
   *  drain-turn promise when this arrival scheduled one, so the caller can
   *  await the turn without holding the arrival chain. */
  const dispatchArrival = async (input: { thread: ServeThread; relayed: { text: string; authorId: string; id: string }[]; isMention: boolean }): Promise<{ turn: Promise<void> } | null> => {
    const threadId = input.thread.id;
    if (!draining && (pendingInbox.get(threadId)?.length ?? 0) === 0 && (turnDepth.get(threadId) ?? 0) <= 1) {
      const accept = liveSteers.get(threadId);
      if (accept && (await accept({ relayed: input.relayed }))) return null;
    }
    const inbox = pendingInbox.get(threadId) ?? [];
    const hadPending = inbox.length > 0;
    inbox.push(...input.relayed.map((r) => ({ ...r, isMention: input.isMention })));
    // hard cap, replacing the retired chat queue's maxQueueSize bound
    // (cursor security review on PR #50): without it a flood during one
    // long turn grows memory and the folded prompt without limit. Newest
    // dropped, LOUDLY - the old queue's silent drop-oldest ate the earliest
    // instructions, the worse failure.
    if (inbox.length > 100) {
      log("serve.inbox_dropped", { thread: threadId, dropped: inbox.length - 100 });
      inbox.length = 100;
    }
    pendingInbox.set(threadId, inbox);
    // one drain per non-empty inbox: later arrivals fold into the batch the
    // already-scheduled drain snapshots when it finally runs.
    if (hadPending) return null;
    const turn = tracked(serializedTurn(threadId, async () => {
      const batch = (pendingInbox.get(threadId) ?? []).sort((a, b) => Number(a.id) - Number(b.id));
      pendingInbox.delete(threadId);
      if (batch.length === 0) return;
      try {
        await handleTurn({ thread: input.thread, relayed: batch, isMention: batch.some((m) => m.isMention) });
      } catch (e) {
        // an escaped handleTurn throw (a state-file parse, a Slack API
        // rejection outside relayThread's never-throws boundary) previously
        // died in the chat SDK's catch-and-log: the user's message vanished
        // with no reply and no log line of ours (2026-07-27 report). Tell
        // the thread and keep the daemon serving.
        const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        log("serve.turn_crashed", { thread: input.thread.id, err: detail });
        // a surviving activeTurn marker means the turn is PRESERVED (a drain
        // kill kept it for the next generation's auto-resume): a "re-send it"
        // notice would invite a duplicate run and a failed x would misread a
        // guaranteed retry (cubic review catch, round 3) - log only, the
        // resume machinery owns the messaging. The read is best-effort: an
        // unreadable record (possibly the crash itself) takes the visible
        // crash path.
        let preserved = false;
        try {
          preserved = loadSlackThread(input.thread.id)?.activeTurn !== undefined;
        } catch { /* unreadable record: treat as not preserved */ }
        if (preserved) return;
        try {
          await input.thread.post(
            (async function* () {
              yield `tokenmaxxing: this message's handling crashed: ${detail}. If no reply landed above, re-send it.`;
            })(),
          );
        } catch (postErr) {
          log("serve.turn_crash_notice_failed", { thread: input.thread.id, err: (postErr instanceof Error ? postErr.message : String(postErr)).slice(0, 300) });
        }
        // a crash after runTurn added the hourglass would otherwise read as
        // "processing" forever (codex review catch); setStatus never throws.
        const messageId = batch.at(-1)?.id;
        if (messageId) {
          await setStatus({ threadId: input.thread.id, messageId, emoji: STATUS_EMOJI.failed, op: "add" });
          await setStatus({ threadId: input.thread.id, messageId, emoji: STATUS_EMOJI.processing, op: "remove" });
        }
      }
    }));
    return { turn };
  };

  /** A user reaction in a tracked thread. While the thread waits on an asked
   *  user, THAT user's reaction TO THE ASK is their answer: it relays as a
   *  normal turn for the model to interpret (thumbs up approves, thumbs down
   *  declines - the model decides). "To the ask" is enforced structurally
   *  (review catch: a mid-turn encouragement reaction queued behind the
   *  asking turn must not auto-approve the question it never saw): the
   *  reaction must have occurred AFTER askedAt (occurredAt = the Slack
   *  event_ts) and sit on a message at or after the ask's triggering message
   *  (Slack ids are timestamps, so >= compares post order). Anything that
   *  fails a gate degrades to the unmetered note path, which folds into the
   *  next turn's prompt. The answer path never pre-clears the attention
   *  state (review catch): handleTurn's own consume step clears it at the
   *  point the turn is committed, so a failed thread fetch, an unlinked
   *  channel, or a drain landing mid-await leaves the ask intact for the
   *  nudge and the next daemon generation.
   *  Reactor identity: the answer path only trusts ids that already passed
   *  the author guard as requesters (reaction events carry no team-origin
   *  fields, so isOutsideAuthor cannot run here); the note path fail-closed
   *  verifies the reactor against the home workspace via seam.isHomeUser
   *  and drops non-home or unverifiable reactors loudly (review catch: the
   *  outsiders-never-reach-claude invariant covers context lines too), and
   *  only structurally valid emoji names are ever folded. Removals and
   *  untracked threads are ignored, as are other bots; our own reactions
   *  never arrive (chat core drops isMe reaction events before routing). */
  const onReaction = async (
    input: { threadId: string; messageId: string; emoji: string; userId: string; isBot?: boolean | "unknown"; added: boolean; occurredAt: number | null },
    streamable: (threadId: string) => Promise<{ thread: ServeThread }>,
  ) => {
    if (!input.added || input.isBot === true) return;
    if (!loadSlackThread(input.threadId)) return; // untracked thread
    // unlinked channels are contractually silent AND inert (vercel review
    // catch on PR #43): a reaction stored to pendingReactions here would
    // reach claude after a re-link, the one leak every other unlinked path
    // already closes.
    if (!linkForChannel(cfg, bareChannelId(input.threadId.split(":").slice(0, 2).join(":")))) {
      log("serve.reaction_dropped", { thread: input.threadId, reason: "unlinked-channel" });
      return;
    }
    // bare `serialized` on purpose, so a reaction can never gate steering
    // (adversarial-review catch: counting these bookkeeping riders in
    // turnDepth silently disabled steering for the rest of any turn a user
    // reacted to). Accepted tradeoff (documented, WONTFIX): in the rare
    // shape where an ANSWER turn is queued here behind a live turn, a
    // fresh reply may steer the live turn ahead of the queued answer - both
    // still reach the model, and an answer coexisting with a live turn only
    // occurs in multi-user threads.
    await tracked(serialized(input.threadId, async () => {
      const fresh = loadSlackThread(input.threadId);
      if (!fresh) return; // finished while queued
      const asked = fresh.attention;
      const afterAsk = asked !== undefined && input.occurredAt !== null && input.occurredAt >= Date.parse(asked.askedAt);
      const onAskMessage = asked !== undefined
        && (asked.messageId === undefined || (Number.isFinite(Number(input.messageId)) && Number(input.messageId) >= Number(asked.messageId)));
      // draining takes the durable note path even for an asked user: the
      // answer turn could not run anyway, and a "please re-send" drop notice
      // makes no sense for a reaction - the note survives the restart and
      // folds into the next turn.
      if (!draining && asked && asked.requesterIds.includes(input.userId) && afterAsk && onAskMessage) {
        log("serve.reaction_answer", { thread: input.threadId, emoji: input.emoji });
        try {
          const { thread } = await streamable(input.threadId);
          await handleTurn({
            thread,
            relayed: [{
              text: `<@${input.userId}> answered your pending question with the Slack reaction :${input.emoji}:. Interpret the reaction as their reply and continue.`,
              authorId: input.userId,
              id: input.messageId,
            }],
            isMention: false,
          });
        } catch (e) {
          // a crashed answer turn must not read as an accepted answer (codex
          // review catch): tell the thread and settle the reacted-to
          // message's status so it never reads as processing forever.
          const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
          log("serve.reaction_crashed", { thread: input.threadId, err: detail });
          try {
            await seam.postToThread({ threadId: input.threadId, text: `tokenmaxxing: handling your reaction answer crashed: ${detail}. Reply in the thread to answer instead.` });
          } catch (postErr) {
            log("serve.reaction_crash_notice_failed", { thread: input.threadId, err: (postErr instanceof Error ? postErr.message : String(postErr)).slice(0, 300) });
          }
          await setStatus({ threadId: input.threadId, messageId: input.messageId, emoji: STATUS_EMOJI.failed, op: "add" });
          await setStatus({ threadId: input.threadId, messageId: input.messageId, emoji: STATUS_EMOJI.processing, op: "remove" });
          // handleTurn consumed the attention state (and its question mark)
          // before the turn ran; a crashed answer must not eat the ask (cubic
          // review catch, round 2). Restore both so the nudge sweep and the
          // reaction-answer gates keep working; the restore itself is
          // best-effort (the crash may BE an unreadable record).
          try {
            const cur = loadSlackThread(input.threadId);
            if (cur && !cur.attention) {
              saveSlackThread({ ...cur, attention: asked });
              if (asked.messageId) {
                await setStatus({ threadId: input.threadId, messageId: asked.messageId, emoji: STATUS_EMOJI.attention, op: "add" });
              }
            }
          } catch (restoreErr) {
            log("serve.attention_restore_failed", { thread: input.threadId, err: (restoreErr instanceof Error ? restoreErr.message : String(restoreErr)).slice(0, 300) });
          }
        }
        return;
      }
      const home = await seam.isHomeUser({ userId: input.userId });
      if (home !== true) {
        log("serve.reaction_dropped", { thread: input.threadId, reason: home === false ? "outside-author" : "unverifiable-author" });
        return;
      }
      const validEmoji = input.emoji.length > 0 && input.emoji.length <= 100
        && [...input.emoji].every((ch) => (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "-" || ch === "+" || ch === "'");
      if (!validEmoji) {
        log("serve.reaction_dropped", { thread: input.threadId, reason: "invalid-emoji-name" });
        return;
      }
      const notes = [...(fresh.pendingReactions ?? []), { userId: input.userId, emoji: input.emoji, at: new Date().toISOString() }].slice(-10);
      saveSlackThread({ ...fresh, pendingReactions: notes });
      log("serve.reaction_noted", { thread: input.threadId, emoji: input.emoji });
    }));
  };

  /** One pass over every thread record: threads whose attention went
   *  unanswered past ATTENTION_NUDGE_MS get one mention-tagging reminder.
   *  Greedy and convergent: nudgedAt persists, so re-runs (and daemon
   *  restarts) never repeat a nudge; a failed post retries next sweep,
   *  logged each time. The per-thread work runs inside the serialized chain
   *  so a sweep can never resurrect an attention state a concurrent turn
   *  just cleared. */
  const nudgeSweep = async (input?: { now?: number }) => {
    if (draining) return;
    const now = input?.now ?? Date.now();
    // per-record parsing, not listSlackThreads: state files that fail to
    // parse THROW by contract, but here one corrupt record aborting the
    // whole sweep would silence every OTHER thread's overdue nudge on every
    // tick (codex review catch) - and before the daemon's rejection backstop
    // existed, this bare-interval throw was a whole-daemon crash killing
    // every in-flight turn (2026-07-27 report shape). The skip is logged
    // once per file per daemon run; a 60s tick would repeat it forever.
    let files: string[] = [];
    try {
      files = existsSync(paths.slackThreadsDir) ? readdirSync(paths.slackThreadsDir) : [];
    } catch (e) {
      log("serve.nudge_sweep_error", { err: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
      return;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let record: SlackThread;
      try {
        record = SlackThreadSchema.parse(JSON.parse(readFileSync(join(paths.slackThreadsDir, f), "utf8")));
      } catch (e) {
        if (!sweepSkipLogged.has(f)) {
          sweepSkipLogged.add(f);
          log("serve.nudge_record_skipped", { file: f, err: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
        }
        continue;
      }
      const asked = record.attention;
      if (!asked || asked.nudgedAt !== undefined || now - Date.parse(asked.askedAt) < ATTENTION_NUDGE_MS) continue;
      // unlinked channels are contractually silent in Slack (review catch:
      // `serve unlink` leaves thread records behind, and every other outbound
      // path honors the contract). Skipped without a log line on purpose - a
      // 60s sweep would otherwise repeat the same warning forever.
      if (!linkForChannel(cfg, bareChannelId(record.threadId.split(":").slice(0, 2).join(":")))) continue;
      void tracked(serialized(record.threadId, async () => {
        if (draining) return;
        const fresh = loadSlackThread(record.threadId);
        const due = fresh?.attention;
        if (!fresh || !due || due.nudgedAt !== undefined || now - Date.parse(due.askedAt) < ATTENTION_NUDGE_MS) return;
        const tags = due.requesterIds.map((id) => `<@${id}>`).join(" ");
        try {
          await seam.postToThread({
            threadId: record.threadId,
            text: `${tags || "the requester"} still waiting on your input above.`,
          });
          saveSlackThread({ ...fresh, attention: { ...due, nudgedAt: new Date().toISOString() } });
          log("serve.nudge_sent", { thread: record.threadId });
        } catch (e) {
          const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
          log("serve.nudge_error", { thread: record.threadId, err: detail });
        }
      }));
    }
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
      // serializedTurn: a recovery runs a real claude turn, so it must gate
      // steering-order like any other queued turn.
      await serializedTurn(record.threadId, async () => {
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
          // the abandoned turn's messages must not keep reading as processing.
          for (const id of [turn.messageId, ...(turn.steeredMessageIds ?? [])]) {
            if (!id) continue;
            await setStatus({ threadId: thread.id, messageId: id, emoji: STATUS_EMOJI.failed, op: "add" });
            await setStatus({ threadId: thread.id, messageId: id, emoji: STATUS_EMOJI.processing, op: "remove" });
          }
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
              // terminal exit on a linked channel: settle the trigger's status
              // or its hourglass reads "processing" forever (cubic review
              // catch on PR #43). The unlinked abandon above stays reactionless
              // on purpose: unlinked channels are contractually untouchable.
              for (const id of [turn.messageId, ...(turn.steeredMessageIds ?? [])]) {
                if (!id) continue;
                await setStatus({ threadId: thread.id, messageId: id, emoji: STATUS_EMOJI.failed, op: "add" });
                await setStatus({ threadId: thread.id, messageId: id, emoji: STATUS_EMOJI.processing, op: "remove" });
              }
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
        // the KILLED turn's actual askers outrank the streamable handle's
        // newest-author derivation: a recovered need_attention turn must
        // nudge and answer-gate the users who were actually asked (vercel
        // review catch on PR #43); older markers without the field fall back.
        const resumedRequesterIds = decision.marker.requesterIds ?? requesterIds;
        const { outcome, steeredMessageIds } = await runTurn({ thread, record: fresh, prompt: decision.prompt, requesterIds: resumedRequesterIds, sessionId: decision.sessionId, marker: decision.marker, link });
        await settleTurn({ thread, outcome, startedAt, messageId: decision.marker.messageId, steeredMessageIds, requesterIds: resumedRequesterIds });
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
    onReaction,
    nudgeSweep,
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

/** users.info slice the home-workspace reactor check reads. */
const UsersInfoSchema = z.looseObject({
  ok: z.boolean(),
  user: z.looseObject({ team_id: z.string().optional() }).optional(),
});

/** The raw Slack reaction event slice the daemon reads: event_ts is when the
 *  reaction happened, the discriminator that keeps a pre-ask reaction from
 *  answering a question the user never saw. */
const ReactionRawSchema = z.looseObject({ event_ts: z.string().optional() });

async function runDaemon(): Promise<number> {
  const homeUserCache = new Map<string, boolean>();
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
    // the adapter's default logger is info-level and prints a line per
    // redelivered socket envelope ("Processing socket mode retry") - steady
    // noise during restart catch-up. warn matches the Chat logger below;
    // real degradations (streaming fallback etc.) are warn-level and survive.
    logger: new ConsoleLogger("warn", "chat-sdk").child("slack"),
  });
  // held directly (not only via Chat) so startup can re-subscribe recorded
  // threads: subscriptions live in this in-memory state and die with the
  // process, and only a fresh mention would otherwise revive a thread.
  const state = new MemoryStateAdapter();
  const bot = new Chat({
    userName: "tokenmaxxing",
    adapters: { slack },
    state,
    // CONCURRENT dispatch (steering redesign, superseding the queue strategy
    // and its 1h-TTL/size-100 tuning): every message reaches onMessage the
    // moment Slack delivers it, in arrival order. The queue strategy's
    // 30s dispatch-lock lease made mid-turn messages invisible AND could
    // reorder them - a reply enqueued behind a live lease was only released
    // when a LATER message took the expired lock, dispatching newest-first
    // (adversarial-review catch; chat 4.34.0 handleQueueOrDebounce). The
    // daemon owns everything the queue used to provide: per-thread turn
    // ordering (the serialized chain), mid-turn folding (the steering path),
    // and batching of waiting messages (the per-thread inbox in
    // buildServeRuntime, drained sorted as ONE folded turn). Chat's
    // message-id dedupe runs before the concurrency branch, so the
    // app_mention + message.channels double-delivery stays deduped.
    concurrency: { strategy: "concurrent" },
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
    // reactions.add/remove; the runtime wraps every call in its own log-only
    // guard, so adapter failures (missing reactions:write until the app is
    // reinstalled with the current manifest) stay invisible to turns.
    react: async (input) => {
      if (input.op === "add") await slack.addReaction(input.threadId, input.messageId, input.emoji);
      else await slack.removeReaction(input.threadId, input.messageId, input.emoji);
    },
    // one standalone line (the nudge); a lazy handle posts fine card-less.
    postToThread: async (input) => {
      await bot.thread(input.threadId).post(input.text);
    },
    // reaction events carry no team-origin fields, so the note path verifies
    // reactors via users.info (scope users:read, already in the manifest).
    // Definitive answers cache for the daemon's lifetime; errors return null
    // (fail closed at the caller) without caching so transient failures heal.
    isHomeUser: async (input) => {
      const cached = homeUserCache.get(input.userId);
      if (cached !== undefined) return cached;
      try {
        const resp = UsersInfoSchema.parse(await slack.webClient.users.info({ user: input.userId }));
        const teamId = resp.user?.team_id;
        if (!resp.ok || teamId === undefined) return null;
        const home = teamId === workspaceTeamId;
        homeUserCache.set(input.userId, home);
        return home;
      } catch {
        return null;
      }
    },
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
  // user reactions: an asked user's reaction answers the pending question,
  // anything else folds into the next turn as context (runtime.onReaction).
  // chat core already drops the bot's own reactions before routing.
  bot.onReaction(async (event) => {
    const raw = ReactionRawSchema.safeParse(event.raw);
    const eventTs = raw.success && raw.data.event_ts !== undefined ? Number(raw.data.event_ts) * 1000 : Number.NaN;
    await runtime.onReaction(
      {
        threadId: event.threadId,
        messageId: event.messageId,
        emoji: event.emoji.name,
        userId: event.user.userId,
        isBot: event.user.isBot,
        added: event.added,
        occurredAt: Number.isFinite(eventTs) ? eventTs : null,
      },
      streamableThread,
    );
  });

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

  // LAST-RESORT backstop, not the error strategy: `tracked` is the daemon's
  // own boundary, so this should stay idle - it exists for rejections minted
  // outside our funnels (the chat SDK's socket client, adapter internals),
  // where Bun's default is to kill the whole process (verified 2026-07-27)
  // and with it every concurrent session's in-flight turn, leaving
  // half-streamed Slack messages and no daemon to resume the markers.
  // Sync throws keep the default crash: an uncaughtException means state is
  // undefined and the durable markers make a restart the honest recovery.
  // message-only, like every other logged error here: a rejection minted by
  // an auth-carrying HTTP client must not persist its request into the log
  // (cursor review catch).
  process.on("unhandledRejection", (reason) => {
    log("serve.unhandled_rejection", { err: (reason instanceof Error ? reason.message : String(reason)).slice(0, 300) });
  });

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

  // overdue-attention sweep: one mention-tagging reminder per unanswered ask.
  // Never cleared: the sweep no-ops while draining, and shutdown exits the
  // process outright.
  setInterval(() => void runtime.nudgeSweep(), NUDGE_SWEEP_MS);

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
