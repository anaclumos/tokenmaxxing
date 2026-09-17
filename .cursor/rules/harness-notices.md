# Harness notices

Facts behind the supervisor's stream-json notices (issue #150), verified 2026-09-17 against Claude Code 2.1.270, Claude Agent SDK 0.3.263, and the T3 Code AppImage.

- A harness session drives claude with `--output-format stream-json` and no `-p`; T3 Code adds `--input-format stream-json --include-partial-messages --permission-prompt-tool stdio` and loads hooks through `--setting-sources=user,project,local`. There is no TUI, so the statusLine command never runs and the seat has no tee; the wrapper's stderr goes to the harness's provider log.
- The SDK's reader enqueues every `system` line whose subtype it does not handle itself, so a line the supervisor writes reaches the harness unchanged. The shape to write is the one the binary uses for its own print-mode notices: `type`, `subtype: "informational"`, `content`, `level`, `uuid`, `session_id`.
- T3 Code's server (`apps/server/dist/bin.mjs` inside `app.asar`, `handleSystemMessage`) turns `informational` at level `warning` and `notification` at priority `high` or `immediate` into a `runtime.warning` activity whose summary is cut at 120 characters; `notice` and `info` levels are dropped, and an unknown subtype renders as an unknown-message warning. Read the bundle by parsing the asar header (8-byte pickle, JSON index, file offsets) with a scratch script rather than installing an extractor.
- The supervisor writes only while no child is alive (after the kill, before the relaunch), so a notice never interleaves with the child's stdout. One line per event; a per-second tick would be a permanent chat row each.
- The hook-output `systemMessage` field cannot carry the wait: the supervisor kills the child within 150 ms of the marker, and a hook cannot tick.
