---
name: serve-steering-default
description: Owner decision 2026-07-27 - a Slack reply landing mid-turn steers the RUNNING turn by default; queueing as the next turn is only the fallback
metadata:
  type: project
---

Owner decision (2026-07-27, mid-session steer while the steering feature itself was being built): "The default should be steering, whenever user replies."

**Why:** Before this, `xx serve` serialized every mid-turn Slack message behind the running turn (the per-thread `serialized` chain plus the Chat SDK queue), so a user watching a long turn go wrong had no way to redirect it - their correction arrived only after the turn finished doing the wrong thing. Claude Code's own interactive surface injects mid-turn messages into the running turn; serve should match it.

**How to apply:** A relayable mid-turn reply in a thread with a live claude attempt folds into that attempt via Agent SDK streaming input (an extra stream-json user message on the child's stdin; the CLI injects it at the next tool boundary, and a message past the last fold window runs as its own turn in the same child - nothing drops). The serve-side queue path remains only for: no live attempt (idle thread), park/retry sleeps (no child to steer), the steer-vs-result race losing, queue depth above the live turn (ordering), and drains (loud drop). Slash commands need no serve-side special case: the CLI itself never folds a leading-slash value and runs it as its own turn. Never make queueing the default again for a plain reply. See [[serve-slackbot-decisions]] and docs/serve.mdx.
