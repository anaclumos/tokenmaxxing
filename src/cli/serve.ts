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
import { delay, uniq } from "es-toolkit";
import { Chat, type StreamChunk } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  bareChannelId,
  isChannelId,
  linkForChannel,
  listSlackThreads,
  loadSlackConfig,
  loadSlackThread,
  removeLink,
  saveSlackConfig,
  saveSlackThread,
  stripLeadingMention,
  upsertLink,
  SlackLinkSchema,
  type SlackConfig,
} from "../lib/slackstate.ts";
import { relayThread } from "../lib/slackbridge.ts";
import { log } from "../lib/log.ts";
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

function cmdServeSetup(): number {
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
  console.log(`${c.green("✓")} saved to slack.json (0600) with ${count({ n: cfg.links.length, noun: "link" })}`);
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

async function runDaemon(): Promise<number> {
  const cfg = loadSlackConfig();
  if (!cfg) {
    printSetupInstructions();
    return 1;
  }
  if (cfg.links.length === 0) {
    console.error(c.red("no channel links - run `tokenmaxxing serve link <channel-id> <repo>` first"));
    return 1;
  }

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
    // instead of racing a second claude spawn on the same cwd. The default
    // 90s queue-entry TTL silently discards anything queued behind a turn
    // longer than that (claude turns routinely are), hence the override.
    concurrency: { strategy: "queue", queueEntryTtlMs: 900_000 },
    // without this a cards-only segment in post-and-edit fallback would
    // strand a bare "..." placeholder message.
    fallbackStreamingPlaceholderText: null,
    logger: "warn",
  });

  // in-flight turns, tracked so a shutdown signal can drain them instead of
  // killing a half-streamed answer (live incident 2026-07-18: a deploy
  // restart cut a turn mid-sentence and the answer never reached Slack).
  const activeTurns = new Set<Promise<void>>();
  let draining = false;

  const handleTurn = async (input: {
    thread: { id: string; channelId: string; post: (m: AsyncIterable<string | StreamChunk>) => Promise<unknown>; subscribe: () => Promise<void>; startTyping: () => Promise<void> };
    texts: string[];
    /** bare Slack user ids (U...) of every relayed message's author this
     *  turn: queue-skipped messages fold into one prompt, so a decision may
     *  be owed to an earlier sender, not just the triggering one (review
     *  catch 2026-07-18). */
    requesterIds: string[];
    isMention: boolean;
  }) => {
    const { thread, texts, isMention } = input;
    if (draining) {
      // the socket stays connected until the drain finishes; anything landing
      // in that window is dropped loudly rather than spawning an unwaitable
      // turn. The user re-sends after the restart.
      log("serve.drain_dropped", { thread: thread.id });
      return;
    }
    const link = linkForChannel(cfg, bareChannelId(thread.channelId));
    if (!link) {
      log("serve.unlinked_channel", { channel: thread.channelId });
      return; // not a linked channel - stay silent in Slack
    }
    log("serve.message", { thread: thread.id, isMention, texts: texts.length });
    // texts carries queue-skipped messages plus the triggering one: the queue
    // strategy hands a turn only the LATEST message and the rest via
    // context.skipped, so they are folded into one prompt here.
    const prompt = texts
      .map((t) => stripLeadingMention({ text: t, botUserId: slack.botUserId ?? null }))
      .filter((t) => t !== "")
      .join("\n\n");
    if (!prompt) return;
    let record = loadSlackThread(thread.id);
    if (!record) {
      if (!isMention) return; // only a mention opens a session
      record = { threadId: thread.id, repo: link.repo, cwd: link.repo, sessionId: null, createdAt: new Date().toISOString() };
      saveSlackThread(record);
      log("serve.thread_opened", { thread: thread.id, cwd: record.cwd });
    }
    // subscriptions live in the memory state, so a daemon restart forgets
    // them; every mention re-subscribes to keep follow-up replies flowing.
    if (isMention) await thread.subscribe();
    // "is working..." assistant status; a no-op until the Slack app has the
    // agent feature + assistant:write (the adapter warns instead of throwing).
    await thread.startTyping();
    const outcome = await relayThread({
      cwd: record.cwd,
      sessionId: record.sessionId,
      prompt,
      requesterIds: input.requesterIds,
      link,
      post: (m) => thread.post(m),
    });
    if (outcome.sessionId !== record.sessionId) {
      saveSlackThread({ ...record, sessionId: outcome.sessionId });
    }
  };

  const relayable = (m: { author: { isMe: boolean; isBot?: boolean | "unknown" } }) => !m.author.isMe && m.author.isBot !== true;

  const tracked = async (turn: Promise<void>) => {
    activeTurns.add(turn);
    try {
      await turn;
    } finally {
      activeTurns.delete(turn);
    }
  };

  bot.onNewMention(async (thread, message, context) => {
    const relayed = [...(context?.skipped ?? []).filter(relayable), message];
    const texts = relayed.map((m) => m.text);
    await tracked(handleTurn({ thread, texts, requesterIds: uniq(relayed.map((m) => m.author.userId)), isMention: true }));
  });
  bot.onSubscribedMessage(async (thread, message, context) => {
    if (!relayable(message)) return; // never relay our own posts
    const relayed = [...(context?.skipped ?? []).filter(relayable), message];
    const texts = relayed.map((m) => m.text);
    await tracked(handleTurn({ thread, texts, requesterIds: uniq(relayed.map((m) => m.author.userId)), isMention: false }));
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

  // drain instead of dying mid-answer: stop taking new turns, let in-flight
  // ones finish (bounded - a hung claude turn must not block a restart
  // forever), then disconnect. A second signal forces an immediate exit.
  const DRAIN_MS = 300_000;
  const shutdown = async (signal: string) => {
    if (draining) {
      log("serve.forced_exit", { signal });
      process.exit(1);
    }
    draining = true;
    log("serve.draining", { signal, turns: activeTurns.size });
    console.log(`${c.yellow("●")} ${signal}: draining ${count({ n: activeTurns.size, noun: "in-flight turn" })} (again to force)`);
    await Promise.race([Promise.allSettled([...activeTurns]), delay(DRAIN_MS)]);
    await bot.shutdown();
    log("serve.stopped", { dropped: activeTurns.size });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

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
