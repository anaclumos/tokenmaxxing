---
name: no-rm-rf-command-form
description: The rm -rf command FORM is banned absolutely in shell usage - the session-temporaries exception permits deleting temp artifacts, not using forbidden recursive commands on them
metadata:
  type: feedback
---

The AGENTS safeguard "No `rm -rf` ... use `trash`" bans the COMMAND FORM absolutely (Stop-hook enforcement 2026-07-16). The "temporary artifacts this session created are the one exception" clause modifies only "avoid deleting files at all": session temporaries MAY be deleted, but not via `rm -rf`/forced recursive deletes.

**Why:** a recursive force delete is unrecoverable regardless of what it points at today; a retargeted variable or typo makes it catastrophic.

**How to apply:** for scratch dirs, prefer fresh unique names over clearing (mkdir a new dir instead of rm -rf the old), or `trash` for directories; single-file `rm -f` only where unavoidable (the macOS `rm -i` alias gotcha). In PRODUCT code, the user-approved exception for credential-bearing onboard dirs ([[credential-dir-cleanup-rule]]) uses rmSync and stands separately.
