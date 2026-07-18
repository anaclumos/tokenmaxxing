---
name: serve-session
description: How a tokenmaxxing serve session runs - the shared repo checkout, session resume across turns, when to cut your own git worktree, and how to hand finished work back. Use when deciding where to work, commit, push, or open a PR, or before any operation that moves, deletes, or switches the working directory.
---

# How a serve session runs

tokenmaxxing serve bridges a Slack thread to this Claude Code session. Every
thread message becomes one turn; your streamed output posts back into the
thread as Slack messages.

## Working directory

- This session runs directly IN the linked repo checkout, and it is SHARED:
  the repo's owner and other Slack threads work in the same checkout at the
  same time. Read-only work (answering questions, reviewing code, reading
  logs or history) happens here freely and in parallel. Uncommitted changes
  you do not recognize belong to someone else - never reset, restore, or
  stash over them; stage only your own hunks; on a collision, stop and ask
  (see the ask-the-user skill).
- MUTATING work cuts its own worktree FIRST (`git worktree add`). If the
  task will edit, create, move, or delete files - or run anything that
  writes into the tree - do it from a fresh worktree by default: other
  threads and the owner share this checkout, and two agents editing one tree
  corrupt each other silently. Say in the thread that you cut one, do the
  task's whole life there (follow-ups included), and remove it once the work
  is merged. Skip the worktree only when the user explicitly asked for a
  change in this checkout itself.
- Your session's cwd stays the SHARED CHECKOUT on every turn regardless (each
  turn is a fresh process at the recorded cwd, and resume is keyed to it, so
  the daemon can never move it). Reach your worktree by absolute path - or
  `cd` inside each command - every turn; never rely on a previous turn's
  `cd`, and re-read the thread for the worktree path when resuming a task.
- Session resume is keyed to the session's cwd. Never delete or move it, and
  never switch the checkout's branch without asking: the thread (and other
  people's work) would break.

## Turns

- Each turn is a fresh claude process resumed by session id: the conversation
  transcript carries over, but background processes and unsaved in-memory
  state do not. Persist anything a later turn needs to files.
- Nothing can answer an interactive dialog mid-turn. To get the user's input,
  follow the ask-the-user skill.

## Handing work back

- Follow the repo's own shipping conventions (its AGENTS.md or CLAUDE.md);
  when in doubt, branch and open a PR rather than committing to the default
  branch. Push or merge only when the user asks.
