---
name: switching-policy
description: Explain and apply tokenmaxxing switch policy (one bar per window, pace pressure, depleted wait, model-family matching). Use before pool_switch, pool_check, or when changing thresholds.
---

# Switching policy

## Vocabulary

- **Bars**: `thresholdBars(cfg)` = `thresholds.session` (default 90) and `thresholds.weekly` (default 98), one number each, minus `policy.projectionMargin`. Trigger and screening share these bars or swaps ping-pong. Codex reads the same bars.
- **Engaged**: the live account's measured usage is at or over a bar (session, weekly aggregate, or a gated per-model cap). Under both bars the seat holds; there is no separate engagement floor.
- **Usable**: `isExhausted` is false: no cached window (session, weekly aggregate, gated per-model caps, `enforcedUntil`) is at or over its bar, and the account does not need reauth.
- **Pace pressure**: remaining weekly percent / time to weekly reset (highest first). Not most-remaining. Organization membership is not a ranking input. Manual switch uses the same ranking.
- **Verification** attempts at most two stale candidates per evaluation, with a 12-second deadline covering identity reads and the CLI for each candidate; results are persisted and re-ranked, unavailable verification leaves cached figures in force, and verification never spends a parked refresh grant.
- **Depleted wait**: nothing usable means park to the soonest reset within `policy.maxWaitMs`, at the bar rather than at 100. Codex has no pause and rides its account until the server refuses it.
- **Check cadence**: every band is a multiple of the tick `policy.checkIntervalMs` (default 60000).

## Model matching

Match model families by exact token after splitting id/display on spaces, dots, and hyphens (`familyTokens` / `matchedFamily` in `src/lib/usage.ts`). Never exact full display strings (names drift: "Fable" / "Fable 5"). Unmeasured usage is unknown and ranks last, never 0 / first. Per-model weekly caps: Sonnet and Fable exist; only Fable gates a switch by default (`policy.switchModels`).

## Agent actions

- Explain with this skill; mutate only via MCP `pool_switch` / `pool_check` with user approval, `confirm=true`, and `TOKENMAXXING_AGENT_MUTATIONS=1`.
- Do not reintroduce Stop-hook text-sniffing limit failsafes, a session ladder, an engagement floor, organization affinity, incumbent hysteresis, or wall bars.

See [references/policy.md](references/policy.md).
