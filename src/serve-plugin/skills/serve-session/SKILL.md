---
name: serve-session
description: How a tokenmaxxing serve session runs - the per-thread git worktree and branch, session resume across turns, and how to hand finished work back. Use when deciding where to commit, push, or open a PR, or before any operation that moves, deletes, or switches the working directory.
---

# How a serve session runs

tokenmaxxing serve bridges a Slack thread to this Claude Code session. Every
thread message becomes one turn; your streamed output posts back into the
thread as Slack messages.

## Working directory

- Worktree mode (the default): this session runs in its own git worktree,
  `slack-worktrees/<threadKey>` under the tokenmaxxing config dir, on branch
  `tm-slack-<threadKey>` cut from the linked repo's HEAD when the thread
  opened.
- In-place mode (channels linked with --no-worktree): the session runs in the
  linked repo itself and shares its checkout with the user. Be conservative
  there, and never switch branches without asking.
- Session resume is keyed to this directory. Never delete, move, or
  `git worktree remove` it: the thread would lose its session.

## Turns

- Each turn is a fresh claude process resumed by session id: the conversation
  transcript carries over, but background processes and unsaved in-memory
  state do not. Persist anything a later turn needs to files.
- Nothing can answer an interactive dialog mid-turn. To get the user's input,
  follow the ask-the-user skill.

## Handing work back

- In worktree mode, commit on the thread branch; do not commit to the linked
  repo's default branch from here.
- The worktree is never auto-deleted, so committed work survives the thread
  going quiet. Push the branch or open a PR when the user asks.
