---
name: 1password-signing-lock-blocks-commits
description: git commit fails with "1Password - failed to fill whole buffer" when the vault auto-locks; only the user unlocking 1Password fixes it - never bypass with --no-gpg-sign
metadata:
  type: reference
---

On the Mac, commits are SSH-signed via 1Password (`gpg.format ssh`, `gpg.ssh.program op-ssh-sign`, `commit.gpgsign true`). When the 1Password vault auto-locks, every `git commit` fails with `error: 1Password: failed to fill whole buffer` / `fatal: failed to write commit object` - nothing is committed, staged files stay staged, and retrying does not help until the user unlocks the vault (observed 2026-07-19: hours of 5-minute retries all failed until the user returned).

**Why:** signing is part of writing the commit object, so a locked vault blocks all commit creation; earlier same-day commits succeeding then failures starting mid-session is the auto-lock signature.

**How to apply:** on this error, do not spin fast retry loops (each attempt can queue an unlock dialog) and NEVER bypass with `--no-gpg-sign` (a unilateral change to the user's signing posture - the no-hacks rule applies). Stage the work, verify it green, ping the user in Slack per the ship flow ([[shipping-pr-based]]), and arm a slow background retry so the ship completes when they unlock.
