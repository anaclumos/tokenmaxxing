---
name: pr-review-replies-threaded
description: user 2026-07-18 - answer PR review findings as THREADED replies on each inline comment, never only a separate PR-level comment
metadata:
  type: feedback
---

When handling PR review comments (bot or human), reply DIRECTLY on each inline comment's thread: `gh api repos/<owner>/<repo>/pulls/<pr>/comments/<comment_id>/replies -f body=...`. A separate top-level PR comment does not count as handling the thread.

**Why:** The user said so explicitly (2026-07-18, PR #18): "You must also directly reply to the comment, not as a separate comment." Threaded replies keep the disposition (fixed-in-sha or refutation) attached to the finding, let reviewers resolve threads, and stop unresolved threads from re-anchoring to every new commit looking like fresh findings.

**How to apply:** For every finding: agree -> fix, then reply on its thread with the fixing commit sha; refute -> reply on its thread with the reasoning. A summary PR comment is optional garnish, never the primary reply. See [[shipping-pr-based]].
