---
name: 1password-signing-lock-blocks-commits
description: "git commit fails with \"1Password - failed to fill whole buffer\" when the vault auto-locks; --no-gpg-sign fallback has STANDING owner authorization (2026-07-20, \"remember this\")"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 085f0c3d-1bd0-4a58-8930-8dfdcf1a0376
  modified: 2026-07-19T16:10:34.390Z
---

On the Mac, commits are SSH-signed via 1Password (`gpg.format ssh`, `gpg.ssh.program op-ssh-sign`, `commit.gpgsign true`). When the 1Password vault auto-locks, every `git commit` fails with `error: 1Password: failed to fill whole buffer` / `fatal: failed to write commit object` - nothing is committed, staged files stay staged, and retrying does not help until the user unlocks the vault (observed 2026-07-19: hours of 5-minute retries all failed until the user returned).

**Why:** signing is part of writing the commit object, so a locked vault blocks all commit creation; earlier same-day commits succeeding then failures starting mid-session is the auto-lock signature.

**How to apply:** the owner granted STANDING authorization for the `--no-gpg-sign` fallback (2026-07-19 "use no-gpg-sign", re-confirmed 2026-07-20 with "remember this") - no per-incident ask needed. Commit with the signed-attempt-then-fallback pattern (`git commit -m ... || git commit --no-gpg-sign -m ...`), note the unsigned fallback and its authorization in the commit body, and avoid fast retry loops on the signing error (each attempt can queue an unlock dialog). Squash merges land GitHub-signed regardless. Related: [[shipping-pr-based]].
