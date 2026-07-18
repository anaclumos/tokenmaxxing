---
name: cc-per-model-limits
description: Per-model weekly caps exist ONLY for Sonnet and Fable (User's Claim 2026-07-12 - there is no Opus-only quota); only Fable's matters for switching, and model NAME MATCHING is a trap (statusLine says "Opus 4.8", /usage row says "Fable")
metadata: 
  node_type: memory
  type: project
  originSessionId: 9acf6a1d-7447-45c7-979e-74076947f60c
---

User's Claim (2026-07-12), superseding the Fable/Opus framing below and resolving the UNVERIFIED note at the bottom: there is NO Opus-only quota. Per-model weekly caps currently exist only for Sonnet and Fable, and only Fable's matters for switching ("we only care about Fable"). `policy.switchModels` now defaults to `["fable"]` (state.ts DEFAULT_CONFIG, changed 2026-07-12). The family-token matching lesson below still stands.

Claude Code subscription quota has THREE distinct limits, confirmed via `claude -p '/usage'` on this machine 2026-07-09 (User's Claim + verified output):
- **Current session** (5-hour rolling): maps to statusLine `rate_limits.five_hour`.
- **Current week (all models)** (7-day aggregate): maps to statusLine `rate_limits.seven_day`.
- **Current week (<Model>)**: a PER-MODEL weekly cap, e.g. "Current week (Fable): 80%". This is NOT in statusLine stdin (statusLine carries only the two aggregate windows).

**Why it matters for [[tokenmaxxing-project]]:** the most-capable model (Fable now, Opus before) has a tight per-model weekly cap that is hit well before the aggregate: this machine was at 50% week-all-models but 80% week-Fable. So the switch trigger must be **model-aware**: when the active model is Fable/Opus and ITS per-model cap is near the threshold, switch accounts even though the aggregate is fine. Sonnet/Haiku have generous limits ("sonnet = ok"). User's exact words: "fable = need to switch, sonnet = ok".

**How to apply:** statusLine shim records the active model (`model.id`/`model.display_name`) + the two aggregate windows into usage.json. The per-model cap comes only from `claude -p '/usage'` (free, 0 tokens): poll it TTL-cached (not every turn) when the active model is capacity-constrained, and trigger a swap if session>=T OR week-all>=T OR week-<activeModel>>=T. Config knob `policy.switchModels` (default fable, opus) selects which models' per-model cap triggers a switch.

**MODEL-NAME MATCHING TRAP (verified in the 2026-07-08/09 ARM-box incident, claude 2.1.205/2.1.206):**
- statusLine `model.display_name` is VERSIONED for Opus: `"Opus 4.8"` (id `claude-opus-4-8`), but appears BARE for Fable: `"Fable"`. Any exact-match gate on lowercased display names (e.g. `["fable","opus"].includes("opus 4.8")`) silently excludes Opus. This was the root cause of the 2026-07-09 ARM-box depletion: the Opus weekly cap drained to 100% (14x "You've hit your weekly limit" over Jul 8-9) with ZERO auto-switch, because decide.ts's `switchModels.includes(display.toLowerCase())` never matched, so the per-model poll and the per-model over-check both never ran (model-usage.json was never even created). Match by family substring/prefix, never exact display string.
- `/usage` per-model rows may not list Opus AT ALL: every `/usage` output captured on the ARM Linux box (probes + entire project transcripts) shows only `Current week (Fable)`, never a `Current week (Opus...)` row, even during the window when an Opus weekly cap was the binding drained limit. All captured probes were of accounts at 0%, so it is UNVERIFIED whether the Opus row appears once that account has real Opus consumption. Before trusting `/usage` as the Opus-cap source, probe an account with known Opus usage and confirm the row's exact label.
