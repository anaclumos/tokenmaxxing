---
name: slack-suspended-until-new-setup
description: "user 2026-07-20 - Slack is not in use right now; a new channel and a new computer come later, so decision pings go in-session (plus push notifications), never to the old channel"
metadata: 
  node_type: memory
  type: project
  originSessionId: 085f0c3d-1bd0-4a58-8930-8dfdcf1a0376
  modified: 2026-07-19T16:05:31.107Z
---

As of 2026-07-20 the owner does not use Slack for this project: do NOT post decision pings, escalations, or status updates to the old dogfooding channel or any other existing channel. A NEW Slack channel and a new computer will be set up later; until then, surface decisions and escalations directly in the session and use a push notification when the owner may be away.

**Why:** the owner said so explicitly ("FYI we don't use slack anymore, right now. We will set up a new Slack channel and a new computer later") while the session was pinging the old channel for a closing-review decision.

**How to apply:** ask in-session via the AskUserQuestion tool (user 2026-07-20: "Just ask me directly here with AskUserQuestion tool... Ask me on Slack when we have it back on"). The owner approved updating AGENTS.md's ship-flow wording accordingly in the 2026-07-20 docs PR. When the new channel is announced, update this memory and revert the flow to Slack tagging. The `xx serve` Slack machinery itself is unaffected code-wise; only the human-notification flow changes. Related: [[shipping-pr-based]], [[silence-is-not-approval-for-design-forks]].
