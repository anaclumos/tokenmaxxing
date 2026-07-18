---
name: source-moves-editor-only
description: Hook correction 2026-07-18 - the editor-only rule covers file MOVES too, not just content edits; never relocate source via Bash (git mv / mkdir+mv)
metadata:
  type: feedback
---

During the docs i18n restructure (2026-07-18) I moved app/ routes with `mkdir + git mv` in Bash and the hook stopped me: the AGENTS.md "all source edits go through the editor tool" rule extends to source file moves.

**Why:** Scripted shell moves are as opaque and error-prone as scripted edits; the repo owner wants every source mutation reviewable through the editor tool surface.

**How to apply:** To relocate a source file, Write the content at the new path with the editor tool and remove the old path separately (deletion rules from [[no-rm-rf-command-form]] still apply). Do not use `git mv`, `mv`, or `mkdir + mv` chains for source files, even when content is unchanged.
