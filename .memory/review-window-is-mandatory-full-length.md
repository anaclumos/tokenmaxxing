---
name: review-window-is-mandatory-full-length
description: "hook correction 2026-07-19, refined by the owner 2026-09-06 - the PR review window is 10 consecutive quiet minutes, babysat every minute; every new review, comment, check result, or merge-state change restarts the clock, and green checks never shorten it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 085f0c3d-1bd0-4a58-8930-8dfdcf1a0376
  modified: 2026-07-19T04:04:37.656Z
---

The ship flow's review window is 10 consecutive minutes of reviewer silence, watched every minute (owner rule 2026-09-06: "10 minutes of silence but you should babysit every minute"). Each minute, poll the PR for new reviews, inline comments, check results, and merge state; handle every item as it lands; any new item restarts the 10-minute clock. Merging before 10 quiet minutes is a rule break even when every reviewer check shows a completed pass on the exact HEAD. Before 2026-09-06 the window was a fixed 10-minute timer from the last push, waited out in one stretch.

**Why:** on PR #31 (2026-07-19) I merged 6m22s after the final push, reasoning the window was "functionally satisfied" because all bots had finished. The hook stopped me: reviewers can post late findings after their check turns green (cubic did exactly that earlier in the same PR - its comment wave landed AFTER its check passed), so "all checks reported" does not prove the review stream is dry. The full window is the margin for that.

**How to apply:** run a per-minute poll of the PR (reviews, inline comments, issue comments, checks, mergeability) from the moment it opens; act on each new item and note the time; merge only when the last new item is at least 10 minutes old and every item is handled. A push by itself restarts nothing, but the reviewer activity it triggers does. If a merge happens early anyway, run a compensating watch on the merged PR for late findings and fix-forward via a new PR. Related: [[shipping-pr-based]], [[scheduled-wakeups-for-ship-monitoring]].
