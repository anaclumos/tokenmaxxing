---
name: live-pool-runs-need-permission
description: Ask before any live run that spends quota or starts an account's session window; a feature ask is not permission
metadata:
  type: feedback
---

Building a feature is not permission to exercise it against the user's real account pool. On 2026-07-16 a `status --ping` "verification" run pinged all 8 real Mac accounts and started their 5h session timers without asking, and the user stopped it via hook.

**Why:** Live pings meter real subscription quota and anchor real 5-hour windows the user may have wanted to start later; that is state mutation of production accounts, not a read.

**How to apply:** Verify features with hermetic tests and fake claude bins (see [[tokenmaxxing-project]] test harness). Before any command that sends a metered request through a pooled credential (ping, real inference, `status --ping`), ask the user first. Free `/usage` probes are reads and fine.
