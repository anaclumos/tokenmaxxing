---
name: statusline-replacement-in-progress
description: Native statusline settled format after the 2026-07-18 colors redesign - quota as ramp color not numbers, 𝒇 fable initial, every account shown, earliest-reset order, subagentStatusLine rows
metadata:
  type: project
---

tokenmaxxing renders claude's statusLine natively (since 2026-07-11; claude-hud fully removed - plugin, marketplace, caches, prior-statusline delegation; install takes the statusLine slot outright). Redesigned 2026-07-18, every choice user-picked via AskUserQuestion or direct mid-turn asks; shipped in v0.18.0 (commit 4e61bdf, npm publish verified live).

**Why:** The user wants tokenmaxxing to own the statusline and iterates on the format live; the 2026-07-18 round reoriented it around reset times with usage conveyed purely by color.

**How to apply:** Full current spec lives in AGENTS.md Statusline section - keep that authoritative. The decisions and whys:

- Quota is COLOR, not numbers: each window token is its reset countdown painted on a continuous green->yellow->red truecolor ramp by used% (anchored green 0 / yellow 75 / red 95 so the old severity bands survive as ramp anchors), 256-cube fallback when COLORTERM lacks truecolor, NO_COLOR falls back to the old glued-number format because a colorless drained window must not look fresh.
- The model name carries the CONTEXT fill color; the `ctx N` token was removed (number survives only in colorless mode).
- Fable per-model initial is 𝒇 (U+1D487 bold italic; user first picked italic 𝑓, then "use a bold variant"). Other families uppercase their first letter; always family-matched, never exact display strings.
- EVERY account renders its own ◇/✗: the counted collapse "◇ 3 full" was removed (user: "it shows 3 full. I think this is confusing").
- Pool and `xx status` (claude + codex sections) sort by EARLIEST upcoming reset (`earliestReset` in picker.ts = min of still-ahead 5h reset and extrapolated weekly expiry; unknown-reset last, needs-reauth last). Display order is informational and decoupled from [[switch-policy-pace-pressure]], which still ranks swaps.
- Subagent info lives in claude's `subagentStatusLine` settings key (per-task rows in the agents panel): `fable (high)  <label>` with the family painted by that task's ctx fill. The MAIN statusline can never show the focused subagent - verified in the 2.1.214 binary, details in [[cc-codex-auth-mechanics]].
- No directory/branch on the line; a linked-worktree basename leads it (unpainted, via the .git-FILE walk in worktree.ts).
- Rejected across all iterations (do not reintroduce): meter glyphs, Unicode fractions, dim ANSI, account names, ●/○ markers, S/W labels, % signs, remaining-instead-of-used, active shown twice, reverse video, numbers-plus-color duplication, counted collapse.
- Gotchas: statusLine stdin sends top-level sub-objects as JSON null (.nullable().optional() everywhere); subagent rows travel as JSON lines so ANSI is escape-encoded in transit and restored by claude's JSON.parse.

Related: [[tokenmaxxing-project]], [[cc-per-model-limits]].
