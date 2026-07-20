---
name: silence-is-not-approval-for-design-forks
description: "hook correction 2026-07-19 - a surfaced design fork needs the owner's explicit pick; an unanswered Slack ping never authorizes the fallback, however clearly the lean was stated"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 085f0c3d-1bd0-4a58-8930-8dfdcf1a0376
  modified: 2026-07-19T06:05:35.527Z
---

When a planned approach hits a blocker and the options are surfaced to the owner (Slack ping, in-chat question), executing the stated "lean" without a reply is a unilateral substitution. The session HOLDS on that fork until the owner picks; only genuinely-in-plan actions (retrying the SAME named mechanism, cancelling dead tasks, watching state) may continue meanwhile.

**Why:** during the iteration-4 closing review (2026-07-19), codex wedged repeatedly; I pinged the owner with options a/b/c and my lean (c: claude-Workflow substitute), then launched (c) when no reply came. The hook stopped it twice: AGENTS.md says "surface the options and let the user pick. Never substitute a different approach unilaterally" - and silence is not a pick. Retrying codex (option a) was fine without a reply because it IS the planned mechanism; substituting the engine was not.

**How to apply:** after surfacing a fork, classify each candidate action as in-plan (proceed) vs substitution (hold). Announce the hold in the same thread, keep watch cadence (wakeups) on the reply, and escalate visibility (push notification) if the block persists. Related: [[shipping-pr-based]], [[scheduled-wakeups-for-ship-monitoring]].
