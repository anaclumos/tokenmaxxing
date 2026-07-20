---
name: scheduled-wakeups-for-ship-monitoring
description: "user 2026-07-19 - during long waits (PR review windows, CI) schedule periodic wakeups to manually check state, never rely only on background shells/monitors"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 085f0c3d-1bd0-4a58-8930-8dfdcf1a0376
  modified: 2026-07-19T03:51:49.634Z
---

During any long wait in a ship flow (the 10-minute PR review window, CI runs, external reviewers), schedule periodic wakeups (ScheduleWakeup or the session's equivalent) to manually re-check the external state, in addition to any background `sleep` shells or monitors.

**Why:** the user asked for this explicitly on 2026-07-19 mid-ship ("periodically do scheduled wakeup to manually check, don't just rely on shells and monitors"): a background shell can hang or its completion notification can be missed, silently stalling the ship; a scheduled wakeup is an independent check that always fires.

**How to apply:** when starting a review-window or CI wait, schedule a wakeup at roughly the expected duration (~600s for a review window) carrying the continuation instruction, and keep scheduling follow-ups until the ship sequence (merge, teardown) completes. Related: [[shipping-pr-based]].
