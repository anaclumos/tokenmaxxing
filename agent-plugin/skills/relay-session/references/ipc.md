# Relay IPC checklist

## Cursor

- In: Task prompt, `/tokenmaxxing-claude`, `/tokenmaxxing-codex`
- Out: final message with stdout protocol
- Continue: Task resume after `relay decide` or `relay set-permission-mode`
- Finish: `subagentStop` always (including permission-needed returns)
- Optional: `subagentStart`, Task `preToolUse` / `postToolUse`
- Not a permission channel: `UpdateCurrentStep`, transcripts

## Claude Code

- In: Agent tool prompt
- Out: Agent final result with stdout protocol
- Continue: SendMessage / next Agent turn after decide
- Finish: `SubagentStop` always (including permission-needed returns)
- Optional: `PermissionRequest` / `Notification` on main; worker pings still use relay stdout
- UI only: `subagentStatusLine`

## Finish-hook rule

Permission park returns to main without faking a worker Stop. Worker Stop hooks still run when the worker actually finishes a turn and write additive `relay/turn-done/<session>` markers only.
