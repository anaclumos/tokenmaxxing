---
name: headless-decision-freshness
description: v0.6.1 decision-path invariants - headless snapshot refresh, unknown-model gating, mtime heartbeat, post-swap cooldown, anticipatory-only pre-parking; why each exists
metadata:
  type: project
---

v0.6.1 (2026-07-12) fixed the Linux/headless auto-switch blindness. Invariants to preserve (each guards a verified live failure):

- `loadFreshSnapshots` (decide.ts) is the ONLY snapshot loader for decisions: one `/usage` probe refreshes BOTH usage.json and model-usage.json when the tee is absent/org-drifted/older than `usagePollTtlMs`. The original bug: cold-start discarded perModel + stamped model:null, so `needsPerModel` gated off and the ARM box ignored Fable 95/95 for 9+ hours of checks.
- Unknown model (`model: null`) gates EVERY `switchModels` family; known-unconstrained model gates none ("fable=switch, sonnet=ok" survives). Never "restore" the old matchedFamily-only gate.
- usage.json freshness = file MTIME, not the embedded ts: `writeUsage`'s write-on-change suppression bumps mtime (utimesSync) as the tee's liveness heartbeat. Judging by ts made a live Sonnet session look headless for up to 8.5 of every 10 minutes.
- Per-model caps of gated families count in `isExhausted`/`usableAt` (PickCtx.switchFamilies). Without this an all-Fable-burnt pool round-robin swaps; with it, live-verified: the cascade across the four accounts correctly skipped the fable-burnt one.
- 45s POST_SWAP_COOLDOWN in evaluateAndMaybeSwap: a model-blind evaluation right after a model-aware swap otherwise undoes it (A<->B respawn loop).
- Depleted-path pre-parking (swap onto a still-blocked soonest-recovering account) only when `anticipatory` (supervised stop hook w/ session id - the only caller whose respawn marker pauses until reset). Timer/SessionStart stay put; the normal pick path adopts the target once its reset passes.
- Unknown-reset blocked windows self-bound at sampledAt + window duration (5h/7d); no permanent bench, no waitUntil=now churn.

See [[switch-policy-earliest-expiring]] for the picking policy itself and [[linux-boxes-track-npm]] for why the boxes lagged.
