---
name: serve-turn-death-root-causes
description: 2026-07-27 diagnosis of serve threads dying with "Something went wrong" - Slack server-side stream expiry chrome plus Bun's process-kill on unhandled rejections; fixed in 1.4.0
metadata:
  type: project
---

Two root causes behind serve threads dying with a "Something went wrong" message (owner report 2026-07-27, worse with multiple concurrent threads):

1. The literal "Something went wrong" is SLACK'S OWN client chrome on an orphaned native stream, not text from any layer of our stack (repo, chat SDK, Slack adapter, Agent SDK, and claude binary all ruled out by grep; confirmed via slackapi/python-slack-sdk#1859, where a Slack maintainer confirms undocumented server-side stream expiry: idle around 30s, total lifetime around 300s measured). Any stream started with chat.startStream and never cleanly stopped freezes as that grey pill: daemon death mid-stream, a mid-stream throw, or simply a long silent tool call. The salvage path recovers content into a fresh message but cannot un-freeze the pill.
2. Bun kills the WHOLE process on any unhandled rejection (verified empirically 2026-07-27), and the daemon had fire-and-forget promises (`void tracked(...)`, interval ticks) whose rejections nobody owned. One stray rejection killed every concurrent session at once, orphaned every open stream (one pill per active thread), and nothing restarts a crashed daemon.

**Why:** concurrency correlation confused the diagnosis: more simultaneous threads meant more rejection surfaces and more open streams per death, so the failures looked like a concurrency bug rather than a process-lifetime and stream-lifetime bug.

**How to apply:** fixed in 1.4.0: segment rotation closes any idle (20s) or old (240s) stream cleanly before Slack can expire it; `tracked()` is the daemon's terminal error boundary; a documented last-resort `unhandledRejection` handler covers rejections minted outside our funnels; bounded transient retry (2, resuming the same session) covers non-limit child deaths. Residual gap: an append REJECTED mid-stream still leaves a frozen pill because the adapter never surfaces the dead message's ts (upstream limitation). See [[cc-codex-auth-mechanics]] for the broader serve architecture and docs/serve.mdx for user-facing behavior.
