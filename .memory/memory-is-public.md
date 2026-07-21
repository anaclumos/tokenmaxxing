---
name: memory-is-public
description: User rule 2026-07-20 - .memory is git-tracked in the public repo, so notes carry only public knowledge; no device, Slack, or environment info; Wikipedia-page standard
metadata:
  type: feedback
---

`.memory` is committed to a PUBLIC GitHub repo, so everything written here is readable by the whole internet. The user's rule (2026-07-20): treat this folder as a public Wikipedia page and record only public knowledge.

Never add:

- Device info: hostnames, ssh aliases, hardware identity, machine usernames, local paths that identify a specific machine.
- Slack info: conversation details, user details, workspace details, channel details, any Slack IDs.
- Environment info: .env keys, file information about the owner's environment, credential locations.

**Why:** the traditional agent-memory convention keeps `.memory` gitignored and private, but this repo tracks it, so a habit of recording device or workspace specifics would publish them. The rule keeps the folder safe to commit.

**How to apply:** before writing or editing any note here, strip it down to the generic lesson. A gotcha about an OS, CLI, or library is public and fine; the name or address of the machine it was learned on is not. A note that is only useful with a private detail does not belong here at all. Link: [[tokenmaxxing-project]].
