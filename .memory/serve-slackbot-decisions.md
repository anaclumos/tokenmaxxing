---
name: serve-slackbot-decisions
description: "xx serve Slack bridge decisions - Chat SDK only (EVE dropped, user 2026-07-18), Socket Mode, worktree-per-thread default"
metadata: 
  node_type: memory
  type: project
  originSessionId: 98fc7c12-0e4d-422f-aea0-2a37bfb68ffb
  modified: 2026-07-18T06:55:28.702Z
---

User decisions for the `xx serve` Slack bridge (2026-07-18):

- Use Vercel's Chat SDK (npm `chat` + `@chat-adapter/slack`, both 4.34.x) in Socket Mode (`mode: "socket"` + `runSocketModeListener()`, shipped in vercel/chat PR #162) as the Slack transport for the local Bun daemon. No public URL, no Next.js, no Vercel hosting.
- EVE (npm `eve` 0.25.1, Vercel's agent framework, announced 2026-06-17) was DROPPED by explicit user choice (AskUserQuestion "Chat SDK only") after research showed it is the wrong layer: EVE owns its own model loop via AI Gateway and targets Vercel Functions (Node >=24), so it would replace Claude Code as the brain instead of driving it.
- Spec: `xx serve` links Slack channels to repos (per channel per repo), each Slack thread init opens a Claude Code session, messages relay in and out, worktree mode by default.
- Slack facts verified 2026-07-18: bot needs xoxb- token (scopes: app_mentions:read, channels:history, groups:history, chat:write, files:write, users:read) + xapp- app-level token with connections:write; internal (non-Marketplace) apps keep Tier 3 limits; chat.update is Tier 3 (~50/min) so streaming edits must debounce (~1-2s); mrkdwn text under ~4000 chars, long output via files.uploadV2 with thread_ts; ignore bot_id/subtype bot_message/own user id to avoid self-loops; thread key = event.thread_ts ?? event.ts.
- Claude Code 2.1.214 has `-w, --worktree [name]` natively (verified locally via --help).

Live debugging + user shaping (2026-07-18, all live-verified in #tokenmaxxing-dogfooding = C0BK1NDNM8Q):

- ROOT CAUSE of the first dead run: awaiting `startSocketModeListener({}, ms)` in a loop - it is the serverless leased API, returns instantly without `options.waitUntil`, and the tight await-loop STARVED the event loop so the (already-connected) persistent socket never delivered an event. `bot.initialize()` alone starts the persistent auto-reconnecting client; the daemon just parks forever after it.
- Chat SDK ids are adapter-prefixed (`slack:C0123`, `slack:C0123:<ts>`); links store bare ids -> `bareChannelId` on every lookup (bug #2: silent no-match).
- User-shaped representation: native append-streaming (chat.startStream) + task cards is CORRECT (user rejected the post-and-edit fallback: "the previous approach was correct"); it works in channel threads even though auth.test x-oauth-scopes lacks assistant:write - never gate on a scope probe (shipped + reverted same day). Cards: "Thinking"/tool name/"Turn" (Title Case per user), input summary + output, closing Turn card with cost/duration. Segment breaks: a tool starting after streamed text closes the Slack message and the rest posts as a new one (user: "should be separate messages at Ran it").
- bypassPermissions needs `allowDangerouslySkipPermissions: true` in the Agent SDK or it refuses; `--yolo` is the user-facing flag name. `AskUserQuestion` is disallowedTools in relayed turns (user asked why its card appeared: no one can answer a dialog over Slack).
- queue strategy: handler gets only the LATEST message, earlier ones in `context.skipped` (fold into prompt); default 90s queueEntryTtl drops messages queued behind a long turn (raised to 900s); webClientOptions pins fiveRetriesInFiveMinutes (default retry can stall ~30min).
- `.memory` is git-tracked since 2026-07-18 (user: "memory should be git controlled") so thread worktrees inherit it; npm `files` whitelist keeps it out of the package.

Slash-command relay (user ask 2026-07-18: "use slash commands such as goal or usage etc inside slack"):

- The passthrough is native: the SDK delivers a string prompt as one stream-json user message and the CLI routes any prompt whose trim starts with "/" through its command table - works identically on fresh and resumed sessions (live-verified /usage twice + /context, all free reads).
- Local command output (num_turns 0, cost 0) arrives as a NON-streamed assistant message plus `result.result`; relayThread's no-text fallback posts it. `system/local_command_output` exists on the wire schema but the current engine does not emit it for these commands; slackstream maps it anyway as the documented fallback surface (posting it suppresses the result fallback, so no double-post either way).
- /goal is a real built-in (2.1.139+): sets a completion condition evaluated by the small-fast model after each turn, works in -p/SDK mode, and an active goal is RESTORED on resume - so it survives the bridge's one-query-per-message pattern. /usage /cost /context /compact /recap /model etc. are supportsNonInteractive builtins; user-level plugin skills load with NO settingSources needed (init slash_commands listed 334 on this Mac).
- SLACK GOTCHA (docs + 2026 issue reports, two independent research passes): the composer eats ANY message whose FIRST char is "/" client-side - channels AND thread replies - before any bot sees it; unknown commands show only an ephemeral error. Registered app slash commands cannot dispatch from threads at all, so registering our own commands is a dead end for thread sessions. The two forms that DO arrive: `@tokenmaxxing /usage` (mention-first) and ` /usage` (leading space, Slack's own documented workaround); both normalize to a position-0 command via stripLeadingMention. A command folded behind queue-skipped texts is prose (position != 0), same as interactive claude.

Related: [[tokenmaxxing-project]], [[agent-sdk-auth-surface]]
