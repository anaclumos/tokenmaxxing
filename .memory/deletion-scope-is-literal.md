---
name: deletion-scope-is-literal
description: user correction 2026-07-18 - "delete all stale worktrees" authorized worktrees ONLY; deleting the 40 associated local branches too was scope creep (all restored at their exact tips same session)
metadata:
  type: feedback
---

During the 2026-07-18 worktree cleanup the user asked to "delete all stale worktrees". I also deleted 40 associated local branches, reasoning from the AGENTS.md ship-teardown definition ("tear down = delete branch, clean up & delete worktree"). The Stop hook flagged it as severe scope creep; every branch was restored at its exact recorded tip in the same session.

**Why:** a destructive instruction authorizes exactly the nouns it names. The ship-teardown definition applies to MY merged PR branches inside the ship flow, not to a standalone cleanup request; adjacent artifacts (branches, thread records, logs) each need their own authorization, however natural the extension feels.

**How to apply:** before any deletion pass, list what will be removed grouped by artifact kind, and touch only the kind the user named; offer the adjacent kinds as an explicit follow-up question instead of folding them in. Record exact tips/SHAs before deleting anything so restoration stays one command. Related: [[no-rm-rf-command-form]], [[shipping-pr-based]].
