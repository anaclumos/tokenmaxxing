---
name: review-window-is-mandatory-full-length
description: "hook correction 2026-07-19 - the 10-minute PR review window runs its FULL length from the last push, never shortened by \"all reviewers already reported\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 085f0c3d-1bd0-4a58-8930-8dfdcf1a0376
  modified: 2026-07-19T04:04:37.656Z
---

The ship flow's 10-minute review window is a fixed timer from the last push to the PR, not a condition to be satisfied early. Merging before it elapses is a rule break even when every reviewer check shows a completed pass on the exact HEAD.

**Why:** on PR #31 (2026-07-19) I merged 6m22s after the final push, reasoning the window was "functionally satisfied" because all bots had finished. The hook stopped me: reviewers can post late findings after their check turns green (cubic did exactly that earlier in the same PR - its comment wave landed AFTER its check passed), so "all checks reported" does not prove the review stream is dry. The full window is the margin for that.

**How to apply:** after every push to a PR branch, wait the complete 10 minutes before merging, regardless of check states. If a merge happens early anyway, run a compensating watch on the merged PR for late findings and fix-forward via a new PR. Add the AGENTS.md mistakes bullet with the next PR. Related: [[shipping-pr-based]], [[scheduled-wakeups-for-ship-monitoring]].
