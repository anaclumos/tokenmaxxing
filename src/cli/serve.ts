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
import { Chat, ThreadImpl, type StreamChunk } from "chat";
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
import { acquireLock } from "../lib/lock.ts";
import { paths } from "../lib/paths.ts";
import { log, setLogEcho } from "../lib/log.ts";
import { c, count } from "./render.ts";

const SERVE_USAGE = "usage: tokenmaxxing serve [setup | link <channel-id> <repo> [--yolo | --dangerous] [--model <m>] | unlink <channel-id> | links]";

/** The manifest the user pastes at api.slack.com/apps > From an app manifest.
 *  Scopes/events verified against docs.slack.dev 2026-07-18: a channel-thread
 *  relay plus Slack's Agent messaging experience (agent_view + assistant:write
 *  power the DM assistant surface and typing status; channel-thread streaming
 *  works without them, verified live). Changing scopes on an existing app
 *  requires reinstalling it to the workspace. */
const APP_MANIFEST = `display_information:
  name: tokenmaxxing
  description: bridges Slack threads to Claude Code sessions

features:
  agent_view: true
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
const YELLOW_EVENT_ENDINGS = ["_dropped", "_drift", "_unparsed", "_gave_up", "_abort", "forced_exit", "proceed_without", "draining"];

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
  acquireLock(paths.serveLockFile);

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
    // silently-vanished, hence a full hour.
    concurrency: { strategy: "queue", queueEntryTtlMs: 3_600_000 },
    // without this a cards-only segment in post-and-edit fallback would
    // strand a bare "..." placeholder message.
    fallbackStreamingPlaceholderText: null,
    logger: "warn",
  });

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
    thread: { id: string; post: (m: AsyncIterable<string | StreamChunk>) => Promise<unknown> };
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
      outcome = await relayThread({
        cwd: record.cwd,
        sessionId: input.sessionId,
        prompt: input.prompt,
        requesterIds: input.requesterIds,
        link: input.link,
        post: (m) => input.thread.post(m),
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
      const presumedKilled = draining && (outcome?.failed ?? true);
      saveSlackThread(presumedKilled ? record : omit(record, ["activeTurn"]));
    }
  };

  const handleTurn = async (input: {
    thread: { id: string; channelId: string; post: (m: string | AsyncIterable<string | StreamChunk>) => Promise<unknown>; subscribe: () => Promise<void>; unsubscribe: () => Promise<void>; startTyping: () => Promise<void> };
    /** every relayed message this turn (queue-skipped + triggering), text
     *  paired with its author id: a decision may be owed to an earlier
     *  folded sender, and a sender whose whole message was the bot mention
     *  contributes no prompt text, so text and author filter together
     *  (review catches 2026-07-18). */
    relayed: { text: string; authorId: string }[];
    isMention: boolean;
  }) => {
    const { thread, isMention } = input;
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
    const link = linkForChannel(cfg, bareChannelId(thread.channelId));
    if (!link) {
      log("serve.unlinked_channel", { channel: thread.channelId });
      return; // not a linked channel - stay silent in Slack
    }
    log("serve.message", { thread: thread.id, isMention, texts: input.relayed.length });
    // relayed carries queue-skipped messages plus the triggering one: the
    // queue strategy hands a turn only the LATEST message and the rest via
    // context.skipped, so they are folded into one prompt here. A message
    // that is empty once its bot mention is stripped contributes neither
    // prompt text nor a requester id (cursor review catch 2026-07-18).
    const stripped = input.relayed
      .map((m) => ({ text: stripLeadingMention({ text: m.text, botUserId: slack.botUserId ?? null }), authorId: m.authorId }))
      .filter((m) => m.text !== "");
    const prompt = stripped.map((m) => m.text).join("\n\n");
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
    log(outcome.failed ? "serve.turn_failed" : "serve.turn_done", {
      thread: thread.id,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });
    // the user declared the work finished: close the thread now that the
    // turn (and its claude subprocess) is over. Never throw into the caller -
    // the daemon must keep serving other threads.
    if (!outcome.finish) return;
    let result: CleanupOutcome;
    try {
      result = cleanupThread({ threadId: thread.id });
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      log("serve.cleanup_error", { thread: thread.id, err: detail });
      try {
        await thread.post(`tokenmaxxing: cleanup failed: ${detail}`);
      } catch (postErr) {
        // never throw into the caller, but an unposted diagnostic must not
        // vanish silently either.
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
      if (relayable(message)) {
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

  /** The ps lstart token for a pid, or null when no such process. pid + start
   *  time is the standard process identity: equality with the token captured
   *  at spawn proves this is still OUR child, never a recycled pid. LC_ALL=C
   *  pins the lstart rendering (cubic review catch): the capturing and the
   *  comparing daemon generation can run under different locales (terminal vs
   *  launchd), and a formatting mismatch would silently skip a needed reap. */
  const pidStartTime = (pid: number): string | null => {
    const res = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C" } });
    if (res.exitCode !== 0) return null;
    const lstart = res.stdout.toString().trim();
    return lstart === "" ? null : lstart;
  };

  /** Reap a previous generation's detached claude child that survived an
   *  uncatchable daemon death (SIGKILL, crash: the "exit" event never fires
   *  on those, so the hook that kills the group never ran) - resuming beside
   *  a live orphan would put two claude processes on one cwd and session
   *  (adversarial-review catch). Signals fire ONLY on a verified pid+lstart
   *  identity match (cubic review catch: this machine runs the user's real
   *  claude sessions; a recycled pid must never get the kill). SIGTERM the
   *  group, escalate to SIGKILL if it lingers past the grace. */
  const reapOrphan = async (turn: ActiveTurn) => {
    if (turn.pid === undefined || turn.pidStartedAt === undefined) return;
    if (pidStartTime(turn.pid) !== turn.pidStartedAt) return; // gone, or a recycled pid
    log("serve.orphan_reaped", { pid: turn.pid });
    killGroup(turn.pid);
    for (let i = 0; i < 10; i++) {
      await delay(500);
      if (pidStartTime(turn.pid) !== turn.pidStartedAt) return;
    }
    killGroup(turn.pid, "SIGKILL");
  };

  /** Recover one thread whose activeTurn marker survived the previous daemon:
   *  a restart killed that turn mid-run. Notify the thread, then resume the
   *  session (or replay the original prompt when the kill landed before init
   *  assigned a session id); past the retry cap, give up loudly. EVERY branch
   *  runs inside the shared per-thread `serialized` chain and recomputes the
   *  decision from a fresh reload there: an inbound turn (or Slack
   *  redelivering the killed turn's unacked mention) can win the chain first,
   *  handle the thread, and clear the marker - acting on the startup snapshot
   *  would then re-run superseded work and write stale record fields over the
   *  session id that turn persisted (adversarial-review catch). */
  const recoverInterrupted = async (record: SlackThread) => {
    try {
      const { thread, requesterIds } = await streamableThread(record.threadId);
      const link = linkForChannel(cfg, bareChannelId(thread.channelId));
      await serialized(record.threadId, async () => {
        // a drain signal can land between the scan and this turn; leave the
        // marker at its previous count so the next start retries.
        if (draining) return;
        const fresh = loadSlackThread(record.threadId);
        const turn = fresh?.activeTurn;
        const decision = fresh ? resumeDecision(fresh) : null;
        if (!fresh || !turn || !decision) return; // superseded: an earlier turn already cleared the marker
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
    }
  };

  const relayable = (m: { author: { isMe: boolean; isBot?: boolean | "unknown" }; raw?: unknown }) => {
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
    const next = prev.then(run, run);
    threadTurns.set(threadId, next);
    // the .finally chain is its own promise: without the .catch, a rejected
    // turn leaves it as an unhandled rejection even though `next` itself is
    // awaited by the handler (cubic review catch, PR #18).
    void next
      .finally(() => {
        if (threadTurns.get(threadId) === next) threadTurns.delete(threadId);
      })
      .catch(() => {});
    return next;
  };

  // filter EVERY message, trigger included: an outsider (or our own post)
  // arriving last must not discard relayable home-workspace messages queued
  // behind the turn - the queue hands the handler only the latest message and
  // the rest ride context.skipped (review catch, PR #18).
  bot.onNewMention(async (thread, message, context) => {
    const relayed = [...(context?.skipped ?? []), message].filter(relayable).map((m) => ({ text: m.text, authorId: m.author.userId }));
    if (relayed.length === 0) return; // outsider mentions never open a session
    await tracked(serialized(thread.id, () => handleTurn({ thread, relayed, isMention: true })));
  });
  bot.onSubscribedMessage(async (thread, message, context) => {
    const relayed = [...(context?.skipped ?? []), message].filter(relayable).map((m) => ({ text: m.text, authorId: m.author.userId }));
    if (relayed.length === 0) return;
    await tracked(serialized(thread.id, () => handleTurn({ thread, relayed, isMention: false })));
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
    if (draining) {
      log("serve.forced_exit", { signal });
      process.exit(1);
    }
    draining = true;
    drainAbort.abort(); // parked/retrying turns wake, post their drop notice, and finish
    log("serve.draining", { signal, turns: activeTurns.size });
    console.log(`${c.yellow("●")} ${signal}: draining ${count({ n: activeTurns.size, noun: "in-flight turn" })} (again to force)`);
    // re-snapshot until stable inside the deadline: drain-window drop notices
    // join activeTurns after the first snapshot and must still flush.
    const deadline = Date.now() + DRAIN_MS;
    while (activeTurns.size > 0 && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...activeTurns]), delay(deadline - Date.now())]);
    }
    try {
      await bot.shutdown();
    } catch (e) {
      // exit must be reached even when the socket teardown rejects; the
      // second-signal force path must not be the only escape.
      log("serve.shutdown_error", { err: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
    log("serve.stopped", { dropped: activeTurns.size });
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

  // threads whose activeTurn marker survived the previous daemon were killed
  // mid-turn by a restart (live incident 2026-07-18: a redeploy silently
  // killed a ship turn 8 minutes in and the thread just went dark). Each gets
  // a notice and an auto-resumed turn, tracked so a drain waits for them too;
  // the actionable decision is recomputed under the per-thread lock inside.
  for (const record of records) {
    if (!record.activeTurn) continue;
    void tracked(recoverInterrupted(record));
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
