---
name: root-cause-before-retry-layers
description: owner correction 2026-07-27 - adding retry/catch layers around an unexplained failure is monkeypatching; find the mechanism that produces the symptom first
metadata:
  type: feedback
---

While fixing serve turn deaths, the first draft added per-site try/catch wrappers and a retry budget before the failure mechanism was fully identified. The owner stopped it: "that's monkeypatching. Praying until one shot passes through 30 retries. Fix the core problem."

**Why:** retries and catches around an unexplained failure mask deterministic bugs (they fail N times instead of once) and scatter error handling across call sites, while the actual mechanism (in that case: Slack expiring streams server-side, and Bun killing the process on unhandled rejections) stays live.

**How to apply:** when a failure report arrives, keep investigating until the mechanism that PRODUCES the user-visible symptom is identified and verified (here: which layer renders the error text, what kills the process), fix at that layer, and only then decide whether a bounded retry is still warranted for genuinely transient residue. Prefer one structural error boundary (the funnel every task flows through) over per-site catches. See [[serve-turn-death-root-causes]].
