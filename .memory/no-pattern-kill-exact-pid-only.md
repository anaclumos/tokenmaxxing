---
name: no-pattern-kill-exact-pid-only
description: "hook correction 2026-09-07 - never kill by pgrep pattern piped to head; resolve the exact PID of the process you started and kill that one, because the checkout is shared with live sessions"
metadata:
  type: feedback
---

Killing a background process must target one PID that is known to be yours. `kill $(pgrep -f "<pattern>" | head -5)` is banned: it kills whatever the pattern happens to match, in whatever order `pgrep` returns, and `head -5` caps the blast radius without aiming it. Resolve the exact PID instead - the task id the harness returned, `$!` from the launch, or a pidfile written at start - and kill that.

**Why:** this working tree is a shared checkout with live supervisors, hooks, the periodic check, and the owner's real sessions running against it, so a pattern that looks specific can match a process that belongs to someone else. The existing rule to stop processes by PID and never kill a running session or supervisor to free a resource is the same rule; the pattern-kill form is how it gets broken by accident. On 2026-09-07 a stale file-count watcher was killed this way while a workflow's agents were running against the same tree.

**How to apply:** prefer not killing at all - a watcher with a bounded `timeout` expires on its own, and the harness has TaskStop for anything it launched. When a kill is genuinely needed, print the candidate processes first and confirm the one you mean is yours, then kill that single PID. Never chain `pgrep` straight into `kill`, and never use `head`/`xargs` to bound a kill list. Related: [[no-rm-rf-command-form]], [[deletion-scope-is-literal]].
