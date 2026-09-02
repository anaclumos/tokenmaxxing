---
name: xx-quota-chart-labels
description: User rule for xx status quota-chart labels (all lowercase - "5h", "week", short model names like "spark"/"fable", "rsrv" for the gpt-reserve limit) and the GPT-5.3-Codex-Spark / gpt-reserve per-limit cap facts
metadata:
  type: feedback
---

User rule (2026-07-17): in the `xx status` quota charts, every label is lowercase - "5h", "week", and model rows as lowercase short family names ("fable", "spark"). The user first asked for Titlecase "Week", saw it rendered, and reverted to lowercase in the same session; do not reintroduce it.

**Why:** OpenAI added a per-model weekly cap named `GPT-5.3-Codex-Spark` (seen live in the wham usage `additional_rate_limits[]` on the user's codex pro account, 2026-07-17), and xx rendered the raw versioned wire name into the 5-char label column. The user wants chart names lowercase and short, with "Week" set off in Titlecase.

**How to apply:** `codexLimitLabel` (codexusage.ts) derives the label structurally - last non-numeric `familyTokens` token - never by exact string, so version bumps ("GPT-6.x-Codex-Spark") keep mapping to "spark" (same never-exact-strings rule as Claude's Opus display-name trap, see [[cc-per-model-limits]]). Claude per-model rows lowercase their /usage display-name key at render time (status.ts). Statusline conventions are separate and stricter, see [[statusline-replacement-in-progress]].

Addendum (2026-09-02): OpenAI added a second `additional_rate_limits[]` entry named `gpt-reserve` (one weekly window, seen live on the owner's codex account). The structural label "reserve" is 7 chars and overflowed the 5-char column, so the owner ruled it renders as "rsrv". `codexLimitLabel` keeps the structural derivation and applies a display abbreviation map on the derived label afterward (`LIMIT_LABEL_ABBREVIATIONS`), so any future `...-Reserve` wire name still lands on "rsrv". The reserve window also flows into `codexpick.ts` exhaustion screening like every other per-limit window; that behavior was not asked about and is unchanged.
