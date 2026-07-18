// `tokenmaxxing serve` - the Slack bridge daemon. Socket Mode (no public URL):
// a mention in a linked channel opens a claude session for that thread (in its
// own git worktree by default), and every further thread message becomes one
// claude turn whose streamed output posts back into the thread. Stack chosen by
// the user 2026-07-18: Vercel Chat SDK (`chat` + `@chat-adapter/slack`) for
// Slack, the Claude Agent SDK driven through src/sdk.ts for claude (EVE was
// researched and dropped: it owns its own model loop instead of driving
// Claude Code).
//
//   serve setup            print the app manifest + prompt for the two tokens
//   serve link <ch> <repo> [--no-worktree] [--dangerous] [--model <m>]
//   serve unlink <ch>      remove a link
//   serve links            list links
//   serve                  run the daemon

import { existsSync, realpathSync } from "node:fs";
import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  isChannelId,
  linkForChannel,
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
import { ensureThreadCwd, relayTurn, type TurnOutcome } from "../lib/slackbridge.ts";
import { log } from "../lib/log.ts";
import { c, count } from "./render.ts";

const SERVE_USAGE = "usage: tokenmaxxing serve [setup | link <channel-id> <repo> [--no-worktree] [--dangerous] [--model <m>] | unlink <channel-id> | links]";

/** The manifest the user pastes at api.slack.com/apps > From an app manifest.
 *  Scopes/events verified against docs.slack.dev 2026-07-18: exactly what a
 *  channel-thread relay needs, nothing more. */
const APP_MANIFEST = `display_information:
  name: tokenmaxxing
  description: bridges Slack threads to Claude Code sessions

features:
  bot_user:
    display_name: tokenmaxxing
    always_online: true

oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - groups:history
      - chat:write
      - files:write
      - users:read

settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
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
  const worktree = !argv.includes("--no-worktree");
  const dangerous = argv.includes("--dangerous");
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
    console.error(c.red(`${repoReal} is not a git repository (worktree mode needs one)`));
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
    worktree,
    permissionMode: dangerous ? "bypassPermissions" : "acceptEdits",
    ...(model ? { model } : {}),
  });
  saveSlackConfig(upsertLink(cfg, link));
  const flags = [worktree ? "worktree" : "in-place", link.permissionMode, ...(model ? [model] : [])].join(", ");
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
    const flags = [l.worktree ? "worktree" : "in-place", l.permissionMode, ...(l.model ? [l.model] : [])].join(", ");
    console.log(`${c.bold(l.channel)} → ${l.repo} ${c.dim(`(${flags})`)}`);
  }
  return 0;
}

/** One socket lease: how long each startSocketModeListener call holds the
 *  WebSocket before the loop reconnects (the adapter treats the listener as
 *  leased, not infinite). */
const SOCKET_LEASE_MS = 3_600_000;
const MAX_CONSECUTIVE_FAILURES = 3;

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

  const slack = createSlackAdapter({ mode: "socket", botToken: cfg.botToken, appToken: cfg.appToken });
  const bot = new Chat({
    userName: "tokenmaxxing",
    adapters: { slack },
    state: createMemoryState(),
    // per-thread lock with queueing: a message landing mid-turn waits its turn
    // instead of being dropped or racing a second claude spawn on the same cwd.
    concurrency: "queue",
    logger: "warn",
  });

  const handleTurn = async (thread: { id: string; channelId: string; post: (m: AsyncIterable<string>) => Promise<unknown>; subscribe: () => Promise<void> }, rawText: string, isMention: boolean) => {
    const link = linkForChannel(cfg, thread.channelId);
    if (!link) return; // not a linked channel - stay silent
    const prompt = stripLeadingMention(rawText);
    if (!prompt) return;
    let record = loadSlackThread(thread.id);
    if (!record) {
      if (!isMention) return; // only a mention opens a session
      await thread.subscribe();
      const cwd = ensureThreadCwd({ link, threadId: thread.id });
      record = { threadId: thread.id, repo: link.repo, cwd, sessionId: null, createdAt: new Date().toISOString() };
      saveSlackThread(record);
      log("serve.thread_opened", { thread: thread.id, cwd });
    }
    const outcome: TurnOutcome = { sessionId: record.sessionId, failed: false };
    await thread.post(relayTurn({ cwd: record.cwd, sessionId: record.sessionId, prompt, link }, outcome));
    if (outcome.sessionId !== record.sessionId) {
      saveSlackThread({ ...record, sessionId: outcome.sessionId });
    }
  };

  bot.onNewMention(async (thread, message) => {
    await handleTurn(thread, message.text, true);
  });
  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author.isMe || message.author.isBot === true) return; // never relay our own posts
    await handleTurn(thread, message.text, false);
  });

  await bot.initialize();
  console.log(`${c.green("●")} serving ${count({ n: cfg.links.length, noun: "linked channel" })} over Slack Socket Mode - mention the bot in a linked channel to open a session`);

  let consecutiveFailures = 0;
  while (true) {
    try {
      await slack.startSocketModeListener({}, SOCKET_LEASE_MS);
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures += 1;
      const err = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      console.error(c.red(`socket listener failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err}`));
      log("serve.socket_error", { err, consecutiveFailures });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(c.red("giving up after 3 consecutive socket failures - check the tokens with `tokenmaxxing serve setup`"));
        return 1;
      }
      await Bun.sleep(5_000);
    }
  }
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
