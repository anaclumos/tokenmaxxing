---
name: pre-commit-full-diff-inspection
description: Hook correction 2026-07-19 - a diffstat is not the required untruncated pre-commit inspection, bulk agent-generated multi-file changes included
metadata:
  type: feedback
---

Hook correction (2026-07-19, docs humanize ship): I committed an 85-file
agent-generated docs diff after checking only `git diff --cached --stat | tail -2`
plus targeted greps. The AGENTS.md rule ("Inspect `git status` and
`git diff --cached` untruncated immediately before committing") has no
bulk-change or already-verified-by-subagents exemption.

**Why:** subagent verification and spot greps prove properties I thought to
check; the untruncated read is what catches the defect classes I did not
predict. The rule exists precisely for commits too large to eyeball casually.

**How to apply:** before every commit, dump the full staged diff (to the
scratchpad if large) and read all of it, however many chunks that takes.
Stat lines, grep sweeps, and per-file agent verdicts supplement the read;
they never replace it. If a commit already happened without it (as here),
stop advancing the ship and do the full read against the pushed commit
before CI/review/merge steps continue. See [[shipping-pr-based]].
