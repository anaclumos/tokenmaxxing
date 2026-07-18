---
name: xx-quota-chart-labels
description: User rule for xx status quota-chart labels (all lowercase - "5h", "week", short model names like "spark"/"fable") and the GPT-5.3-Codex-Spark per-model cap fact
metadata:
  type: feedback
---

User rule (2026-07-17): in the `xx status` quota charts, every label is lowercase - "5h", "week", and model rows as lowercase short family names ("fable", "spark"). The user first asked for Titlecase "Week", saw it rendered, and reverted to lowercase in the same session; do not reintroduce it.

**Why:** OpenAI added a per-model weekly cap named `GPT-5.3-Codex-Spark` (seen live in the wham usage `additional_rate_limits[]` on the user's codex pro account, 2026-07-17), and xx rendered the raw versioned wire name into the 5-char label column. The user wants chart names lowercase and short, with "Week" set off in Titlecase.

**How to apply:** `codexLimitLabel` (codexusage.ts) derives the label structurally - last non-numeric `familyTokens` token - never by exact string, so version bumps ("GPT-6.x-Codex-Spark") keep mapping to "spark" (same never-exact-strings rule as Claude's Opus display-name trap, see [[cc-per-model-limits]]). Claude per-model rows lowercase their /usage display-name key at render time (status.ts). Statusline conventions are separate and stricter, see [[statusline-replacement-in-progress]].
