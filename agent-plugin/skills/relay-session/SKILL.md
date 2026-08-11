---
name: relay-session
description: Run durable Claude Code or Codex workers through tokenmaxxing relay (tmux). Use when a host agent needs a long-lived pooled worker, permission pings to main, or tokenmaxxing-claude / tokenmaxxing-codex agents.
---

# Relay session

Host agents stay cheap. They shell into `tokenmaxxing relay`, which owns a durable tmux worker (Claude Code or Codex via tokenmaxxing). High-churn concurrent sessions are expected.

Install templates: `tokenmaxxing relay install --target cursor|claude|all`.

## Claude worker permission modes

CLI: `claude --permission-mode <mode>` / `relay set-permission-mode --permission-mode <mode>`.

| Mode | What runs without asking |
|---|---|
| `default` (alias `manual`) | Reads only |
| `acceptEdits` | Reads, file edits, common filesystem cmds in cwd |
| `plan` | Reads (+ classifier-approved cmds when auto available) |
| `auto` | Everything with background safety classifier (**relay default**) |
| `dontAsk` | Only pre-approved tools; else deny |
| `bypassPermissions` | Everything (needs allow-dangerously flags) |

Claude `auto` is classifier-assisted autonomy, not "defer to main". Relay pings main only when the worker would still prompt.

## Cursor Run Modes (main only)

| Run Mode | Role for relay |
|---|---|
| Auto-review | Main decides each ping or escalates to the user |
| Allowlist | Main decides / escalates |
| Run Everything | Main auto-`relay decide --approve` on worker pings |

Do not probe undocumented APIs for main's Run Mode. Main states or infers it.

If Claude main is itself in `bypassPermissions`, auto-approve worker pings the same way.

## Codex mapping

| Claude mode | Codex flags |
|---|---|
| `plan` / `default` | `--sandbox read-only` + ask-for-approval on |
| `acceptEdits` | `--sandbox workspace-write` |
| `auto` | workspace-write + ask-for-approval |
| `dontAsk` | read-only + approval never |
| `bypassPermissions` | `--sandbox danger-full-access` + approval off |

## Shared stdout protocol

```
session: <id>
permission-mode: <mode>
# turn output OR:
permission-needed: <requestId>
summary: <one line>
detail: <flagged action>
session: <id>
permission-mode: auto
```

## Commands

| Command | Job |
|---|---|
| `relay turn` | Ensure session, send prompt, wait until turn-done or permission-needed |
| `relay decide` | Approve/deny pending ping; resume worker |
| `relay set-permission-mode` | Change live worker mode |
| `relay status` / `destroy` / `gc` | Inspect, tear down, reap |
| `relay install` / `relay config` | Host templates + relay.json |

Flags: `--worker claude|codex`, `--session`, `--cwd`, `--permission-mode`, prompt via argv/stdin.

## Finish hooks

1. Cheap relay host finish hooks (`subagentStop` / `SubagentStop`) fire on every return, including `permission-needed`.
2. Worker Stop / Codex Stop still run on real turn finish (pool logic unchanged).
3. Relay turn-done markers are additive under `$TOKENMAXXING_HOME/relay/turn-done/`. Permission park is not a fake worker Stop. Never write into `respawn/`.

## Cursor IPC matrix

| Contract | Relay support |
|---|---|
| Task / custom agent prompt | Primary in |
| Task final message | Primary out (delta or permission-needed) |
| Task resume / interrupt | Continue with decide / set-permission-mode / next turn |
| Foreground / background + completion notify | Prefer foreground under modes that still prompt |
| Frontmatter model / readonly / is_background / tools | Shell-only templates; configurable cheap model |
| `/name` delegate | Same agents |
| subagentStart / subagentStop (+ followup_message) | Optional hooks; finish hooks always run |
| Task preToolUse / postToolUse | Optional |
| UpdateCurrentStep | UI phases only, not permission channel |
| Nesting | Relay must not spawn Task children |

## Claude IPC matrix

| Contract | Relay support |
|---|---|
| Agent tool prompt / final result | Primary |
| SendMessage resume / mid-run | Primary continue path |
| Background + completion notify | Supported |
| Fork / `/subtask` | Supported if host uses it |
| Permission UI bubble | Orthogonal; do not suppress |
| PermissionRequest / Notification | Optional hooks; worker pings stay stdout protocol |
| SubagentStart / SubagentStop | Finish hooks always run on every return including pings |
| Pre/PostToolUse (incl. on Agent) | Optional |
| Agent teams mailbox / task list | Same stdout contract over team delivery |
| Cross-session SendMessage | Supported; peer messages never carry user authority |
| subagentStatusLine | UI only |

## Hard stops

- Never pattern-kill tmux. Destroy by exact session name only.
- Never print credentials or OAuth tokens.
- Never spawn nested Task/Agent from the cheap relay agent.
- Prefer `tokenmaxxing-claude` / `tokenmaxxing-codex` agents over ad-hoc shells.

See [references/ipc.md](references/ipc.md).
