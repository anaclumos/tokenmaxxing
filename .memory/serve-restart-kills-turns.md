---
name: serve-restart-kills-turns
description: 2026-07-18 incident - daemon restarts kill in-flight serve turns silently; four structural gaps remain even on 0.19.1 drain
metadata:
  type: project
---

Incident 2026-07-18 ~19:02 KST (a dogfooding-channel thread, user report "It gets killed like this"): a daemon restart killed an in-flight "ship when done" turn 8 minutes into implementation, with zero notice in the thread.

Verified chain of evidence (tokenmaxxing.log, thread record, worktree, SDK source):

- The serving daemon started 17:43:47 KST running pre-0.19.1 code: its `serve.started` at 08:43:47Z has NO `serve.resubscribed` line (0.19.1 logs it unconditionally at startup) and it still created a worktree at 09:53:56Z (PR #14 dropped worktrees, merged 18:51 KST). So it had no drain/no signal handlers - the 19:02 restart (picking up the freshly merged 0.19.1 + #14) killed it instantly, claude subprocess included.
- Even on 0.19.1, four gaps keep this class of kill alive:
  1. The Agent SDK spawns claude via `child_process.spawn` with NO `detached` (verified in sdk.mjs 0.3.214): the child shares the daemon's process group, so a terminal Ctrl-C SIGINTs the child directly - drain only protects against a targeted `kill <daemon-pid>`.
  2. `DRAIN_MS` 300s vs ship turns that run 30-60+ min: even a clean drain kills them.
  3. `handleTurn` persists `sessionId` only AFTER `relayThread` returns; a first-turn kill leaves the record `sessionId: null` (confirmed on the incident thread), so a follow-up cannot resume the dead session - it starts fresh with no context.
  4. Nothing notifies or resumes an interrupted thread after restart; `serve.resubscribed` only restores routing for FUTURE messages.
- The killed turn's work sits uncommitted in its `slack-worktrees/<threadKey>` worktree (modified `src/lib/slackstate.ts`).

**Why:** serve is redeployed constantly during dogfooding; every redeploy is a restart, so long autonomous turns will keep dying until interrupted-turn recovery exists.

**How to apply:** any restart-resilience fix must at minimum persist sessionId at the init message and leave a durable in-flight marker so startup can notify (or resume) interrupted threads. Related: [[serve-slackbot-decisions]], [[slaude-harvest-verdict]] (drain-drop notice port item).

**Resolution (PR #19, user-picked scope A+B "notice + auto-resume", shipped 2026-07-18):** all four gaps closed - onSessionId persists at init, activeTurn marker + startup auto-resume (cap 3, resumeDecision unit-tested), streamableThread keeps native cards on resumed turns, serialized-chain + serve-lock flock + identity-gated orphan reaper (pid + C-locale lstart) close the race and orphan modes. Load-bearing process facts verified empirically during review: a mid-turn orphan does NOT die on its dead stdout pipe; a prompt-less real-claude child DIES in ~2s on stdin EOF; Bun skips the "exit" event on unhandled-signal death (hence SIGHUP drains). Three merge rounds against seven concurrent serve PRs; three adversarial workflow rounds plus codex/cubic/cursor handling.
