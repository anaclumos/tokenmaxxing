---
name: switching-policy
description: Explain and apply tokenmaxxing switch policy (greedy vs hard path, pace pressure, Layer 2 wall squeeze Claude-only, model-family matching). Use before pool_switch, pool_check, or when changing thresholds.
---

# Switching policy

## Vocabulary

- **Engaged**: session used >= `policy.greedySessionFloor` (default 80) or any screening bar crossed.
- **GREEDY path** permits lateral moves only within the incumbent organization and retains `greedySwapMargin` hysteresis.
- **HARD path** starts at a crossed screening bar and may cross organizations, with Layer 2 as its fallback.
- **Organization preference** requires measured headroom in session, aggregate weekly and gated model windows under the [policy](references/policy.md).
- **Verification** attempts at most two stale candidates per evaluation, with a 12-second deadline covering identity reads and the CLI for each candidate.
- **Probe results** are persisted and re-ranked, while screening exhaustion remains eligible for the wall squeeze and reset selection.
- **Unavailable verification** leaves cached figures in force, and verification never spends a parked refresh grant.
- **Manual switch** retains pure pace ranking with no organization preference or incumbent margin.
- **Pace pressure**: remaining weekly percent / time to weekly reset (highest first). Not most-remaining.
- **Effective bars**: `effectiveBars(cfg, pool)` = the active rung of the 5h ladder (`thresholds.session`, default `[90]`, a single rung: the lowest rung some pooled account, the current one included, still clears) and the weekly bar, each minus `policy.projectionMargin`. Trigger and screening must share these bars or swaps ping-pong. Codex reads `terminalBars(cfg)`, the top rung only. The check cadence is capped one band per rung climbed, and every band is a multiple of the tick `policy.checkIntervalMs` (default 60000).
- **Banked reset**: opt-in via `policy.preferToUseBankedReset` (a provider list, default `[]`), hard path only. Claude: the seat holds between the session rung and the wall while a reset is believed available and the weekly windows have room for one more measured session window (`sessionWindowWeeklyCost`; unmeasured swaps), claims the `/limit-reset` server call at the wall, and keeps the seat on `reset` (the failed turn is retriggered in place). Codex: rides to the wall while a reset credit exists, consumes one, no restart. The greedy path never resets.

## Layer 2 (Claude only)

When the hard path finds no usable target, judge against the wall (`hardThresholds` minus margin). Under-wall seat HOLDS; walled seat swaps to best under-wall sibling. Codex has no Layer 2 last-drop swap (cannot hot-adopt).

## Model matching

Match model families by exact token after splitting id/display on spaces, dots, and hyphens (`familyTokens` / `matchedFamily` in `src/lib/usage.ts`). Never exact full display strings (names drift: "Fable" / "Fable 5"). Unmeasured usage is unknown and ranks last, never 0 / first. Per-model weekly caps: Sonnet and Fable exist; only Fable gates a switch by default (`policy.switchModels`).

## Agent actions

- Explain with this skill; mutate only via MCP `pool_switch` / `pool_check` with user approval, `confirm=true`, and `TOKENMAXXING_AGENT_MUTATIONS=1`.
- Do not reintroduce Stop-hook text-sniffing limit failsafes.

See [references/policy.md](references/policy.md).
