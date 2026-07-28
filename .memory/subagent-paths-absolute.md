---
name: subagent-paths-absolute
description: Self-caught 2026-07-27 - a parallel subagent editing repo files resolved RELATIVE paths against the main checkout, not the session worktree; give subagents absolute per-file paths and verify where their edits landed
metadata:
  type: feedback
---

During the serve-steering docs fan-out (2026-07-27), one of eight translation subagents edited its four files in the main checkout instead of the session worktree. Its prompt named the worktree in prose but listed the files as relative paths; the agent resolved them against its own working directory. The stray edits had to be copied into the worktree and the main checkout restored by hand, on a machine where the main checkout is shared with live sessions.

**Why:** A subagent's working directory is not guaranteed to be the session's worktree, and a prose mention of the right directory does not override how relative paths resolve. On this machine a stray write to the main checkout is a collision hazard with the owner's live sessions, not just lost work.

**How to apply:** When fanning out subagents that WRITE repo files, put the absolute path on every file in the task list, never a directory-in-prose plus relative names. After the fan-out returns, verify placement before using the result: `git status` in both the worktree and the main checkout, and treat any main-checkout drift as the subagent's edits to relocate (editor-only moves, then restore the shared tree from HEAD content). Related: [[deletion-scope-is-literal]] for the verify-what-the-agent-touched habit.
