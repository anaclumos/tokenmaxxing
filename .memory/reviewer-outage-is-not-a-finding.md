---
name: reviewer-outage-is-not-a-finding
description: "owner ruling 2026-09-07 (PR #74) - a review bot's check that fails provably on its own provider outage, not on the code, does not block the merge once every other check is clean and its earlier findings are answered"
metadata:
  type: feedback
---

A review bot's check can fail for reasons that have nothing to do with the diff. When the failure is provably the reviewer's own infrastructure, the owner's call is to merge past it rather than hold the release. On PR #74 (2026-09-07) the pullfrog check went red three reruns in a row over two hours with the same signature: `AI_APICallError: The usage limit has been reached`, the provider never returning a first token, and the harness's activity watchdog aborting the turn. No review body and no inline comments were ever posted, so there was nothing to triage. The owner chose "merge now" over holding or retrying hourly.

**Why:** the silence period exists to catch late reviewer findings ([[review-window-is-mandatory-full-length]]), and a check that cannot reach a verdict produces no findings to wait for. Nothing the shipping side controls turns that check green, so treating it as a blocker stalls the release on a third party's quota with no end date. The judgment is about the *reason* for the red, not the red itself: a bot that reviewed and failed the code is a finding and still blocks.

**How to apply:** read the failing check's log before treating it as either a finding or an outage - the distinction is in the log, never in the check's status. Confirm the run posted no review body and no inline comments, retry it at least twice to establish the failure is sustained rather than a blip, and confirm every other check is pass or skipping and that bot's earlier findings on the PR are all fixed and answered in thread. Then surface the fork to the owner with the evidence rather than deciding alone, since merging is outward-facing; the standing ruling above is the expected answer, not a substitute for asking. Record the outage in a PR comment before merging so the red check has a written explanation next to it. Note what the merge cost: on #74 the final commit never got its adversarial pass. Related: [[shipping-pr-based]], [[collect-reviews-unfiltered]], [[silence-is-not-approval-for-design-forks]].
