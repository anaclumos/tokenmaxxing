---
name: switching-policy
description: Explain and apply tokenmaxxing switch policy (greedy vs hard path, pace pressure, Layer 2 wall squeeze Claude-only, model-family matching). Use before pool_switch, pool_check, or when changing thresholds.
---

# Switching policy

## Vocabulary

- **Engaged**: session used >= `policy.greedySessionFloor` (default 50) or any hard/screening bar crossed.
- **GREEDY path**: engaged but under every bar. Rank all accounts by pace pressure; keep seat on best-or-tie (`currentWins`); else swap to strictly better. Never depleted-waits or pre-parks.
- **HARD path**: a screening bar crossed. Swap to best usable target; if none, Layer 2 wall logic (Claude only).
- **Pace pressure**: remaining weekly percent / time to weekly reset (highest first). Not most-remaining.
- **Effective bars**: `effectiveBars(cfg)` = thresholds minus `policy.projectionMargin`. Trigger and screening must share these bars or swaps ping-pong.

## Layer 2 (Claude only)

When the hard path finds no usable target, judge against the wall (`hardThresholds` minus margin). Under-wall seat HOLDS; walled seat swaps to best under-wall sibling. Codex has no Layer 2 last-drop swap (cannot hot-adopt).

## Model matching

Match model names by family substring or prefix, never exact display strings (names drift: "Fable" / "Fable 5"). Unmeasured usage is unknown and ranks last, never 0 / first. Per-model weekly caps: Sonnet and Fable exist; only Fable gates a switch by default (`policy.switchModels`).

## Agent actions

- Explain with this skill; mutate only via MCP `pool_switch` / `pool_check` with user approval, `confirm=true`, and `TOKENMAXXING_AGENT_MUTATIONS=1`.
- Do not reintroduce Stop-hook text-sniffing limit failsafes.

See [references/policy.md](references/policy.md).
