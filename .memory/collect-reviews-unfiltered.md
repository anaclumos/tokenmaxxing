---
name: collect-reviews-unfiltered
description: self-caught 2026-07-20 - collect PR review comments UNFILTERED every round; a reviewer-name filter left a pullfrog finding unanswered for a full cycle and it silently blocked approval
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 085f0c3d-1bd0-4a58-8930-8dfdcf1a0376
  modified: 2026-07-19T18:58:07.412Z
---

On PR #33 (2026-07-20), one review-handling round queried inline comments with `select(.user.login == "cursor[bot]")` because Bugbot had just posted; a pullfrog finding created in the same minute (decide.ts unpooled-org seat) was invisible to that query, went unanswered for a full round, and quietly held pullfrog's approval at "withheld" until its review body mentioned it.

**Why:** multiple AI reviewers post independently and near-simultaneously after each push; any per-reviewer filter turns "handle every review" into "handle every review I remembered to query".

**How to apply:** each round, list ALL inline comments (`gh api .../pulls/<n>/comments`) and ALL review bodies (`gh pr view --json reviews`), filtering only by timestamp (newer than the last handled push) - never by author. Also read review BODIES for withheld-approval notes; a finding can live there rather than inline. Related: [[pr-review-replies-threaded]], [[review-window-is-mandatory-full-length]].
