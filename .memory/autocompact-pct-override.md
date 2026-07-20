---
name: autocompact-pct-override
description: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 set in ~/.claude/settings.json env (2026-07-19); binary-verified undocumented knob, re-verify on claude updates"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5a1044fc-1b59-4313-912c-d0a2297d303a
  modified: 2026-07-19T03:17:56.311Z
---

The user asked for auto-compact at 50% context on the Mac (2026-07-19). Shipped as `"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50"` in the `env` block of `~/.claude/settings.json`.

Binary-verified against claude 2.1.215 (Mach-O at `~/.local/share/claude/versions/2.1.215`; grep needs `-a`): the env var parses via parseFloat into an internal `testPctOverride`, and the trigger becomes `Math.min(Math.floor(window * pct/100), defaultThreshold)` for 0 < pct <= 100, so it can only lower the trigger below the default. It is a true percentage, so it tracks 50% across models/window sizes, unlike the `autoCompactWindow` setting (fixed token count, min 100000). NOT in the official settings docs (only `autoCompactEnabled` is documented), and the internal name says "test": re-verify the string still exists after claude updates before relying on it. See [[cc-codex-auth-mechanics]] for the monthly re-verify habit.
