---
name: t3-code-forensics
description: Where a T3 Code thread keeps its Claude session logs and state, and how to correlate them with the tokenmaxxing log when a thread is blamed on a missed move
metadata:
  type: reference
---

T3 Code drives claude through the Claude Agent SDK, which spawns the tokenmaxxing wrapper as `__supervise --output-format stream-json --input-format stream-json --include-partial-messages --permission-prompt-tool stdio` and loads hooks through `--setting-sources=user,project,local`.

- Per-thread provider logs: `~/.t3/userdata/logs/provider/events.<threadId>.log`, rotated to `.log.1` and `.log.2`. `providerThreadId` in a line is the Claude session id. `claude/rate_limit_event` lines carry `rate_limit_info.status` (`allowed`, `allowed_warning`, `rejected`) and `unifiedWindows.five_hour.utilization`.
- Thread state: `~/.t3/userdata/state.sqlite`, tables `projection_threads`, `projection_thread_sessions`, `projection_turns`, `projection_thread_messages`, `projection_thread_activities`. Read it readonly with `bun:sqlite` when no `sqlite3` binary is installed.
- The Claude transcript for a T3 session is `~/.claude/projects/<slug>/<sessionId>.jsonl`, where the slug is the session's cwd with every non-alphanumeric character replaced by `-`.
- The server bundle that decides what a supervisor notice renders as is `apps/server/dist/bin.mjs` inside the app's `app.asar` (`handleSystemMessage`). Read it by parsing the asar header (8-byte pickle, JSON index, file offsets) with a scratch script instead of installing an extractor.

Start from the thread's events log and `tokenmaxxing.log` in the tokenmaxxing state directory (`~/.config/tokenmaxxing/` unless `TOKENMAXXING_HOME` moves it) for the same session id. The causes seen so far are a seat burned between turns with no turn boundary (the supervisor's seat watch now covers it) and an orphaned claude after a harness restart (SIGTERM is now forwarded). Never paste account labels or the `--mcp-config` bearer from `sessions/<sid>.json` into an issue or PR.
