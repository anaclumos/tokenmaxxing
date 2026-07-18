---
name: credential-dir-cleanup-rule
description: User decision 2026-07-16 - credential-bearing transient dirs tokenmaxxing creates (onboard homes) are hard-deleted with rmSync, the one exception to the no-forced-recursive-delete/trash safeguard
metadata:
  type: feedback
---

The AGENTS safeguard "no forced recursive deletes, use trash" has ONE user-confirmed exception (AskUserQuestion 2026-07-16, answer "Hard-delete these"): transient dirs tokenmaxxing itself creates that contain plaintext credentials (the claude and codex onboard homes). Trashing them would keep a live OAuth token readable in the Trash; rmSync destroys it.

**Why:** two of the user's rules collided (reversible deletes vs never leaving credential material readable); the user picked credential safety.

**How to apply:** keep `rmSync(onboardDir, { recursive: true, force: true })` in add/onboard flows, with an in-file comment citing this decision. Everything else still follows the trash rule. Link: [[tokenmaxxing-project]].
