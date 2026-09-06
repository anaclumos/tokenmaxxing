---
name: account-labels-are-pii
description: owner correction 2026-09-06 - pool account labels are personal data (seats are named after people); never paste status, ls, doctor, or log output with labels, emails, or org names into a PR body, commit, doc, memory, or subagent prompt; mask or count them
metadata:
  type: feedback
---

Pool account labels count as personal data, the same as the emails and organization names already covered by the public-repo rule. The owner names seats after the people who hold them, so a `status` or `ls` dump is a list of names.

**Why:** the 1.17.0 PR body carried a verbatim `status --json` summary as proof of the fix. Emails were masked; the labels were not, and the body sat public for about five minutes before the owner caught it.

**How to apply:** proof in a PR body is counts and shapes ("exactly one active seat", "14 of 15 parked credentials resolve to their own account"), never the rows. Mask labels the way emails are masked before any output leaves the machine, including in prompts to subagents. Canonical rule text lives in AGENTS.md under Safeguards. Related: [[memory-is-public]], [[team-seats-share-org-identity]].
