---
name: source-moves-editor-only
description: Hook corrections 2026-07-18 and 2026-09-07 - the editor-only rule covers file MOVES and SCRIPTED WRITES, not just hand edits; never relocate source via Bash (git mv / mkdir+mv) and never let a script write a repo file
metadata:
  type: feedback
---

Every mutation of a repo file goes through the editor tool. Two ways this rule gets broken, both caught by the hook:

- **Moves** (2026-07-18): during the docs i18n restructure I relocated app/ routes with `mkdir + git mv` in Bash. The "all source edits go through the editor tool" rule extends to moves.
- **Scripted writes** (2026-09-07, twice in one session): I edited `.mdx` files with a Python heredoc calling `Path.write_text`, once during the banked-reset docs pass and again while fixing two locale files. A script writing the file is the same violation as a scripted move, however small or mechanical the change - and "I already verified the result is correct" does not retire it, because the objection is to the method, not the outcome.

**Why:** Scripted shell moves and scripted writes are as opaque and error-prone as scripted edits; the repo owner wants every source mutation reviewable through the editor tool surface, where the exact before/after is visible.

**How to apply:** Use Edit/Write for every repo file change, including one-line and bulk-mechanical ones. Reading with `cat`/`sed -n`/`grep` and computing line numbers in a script is fine - the write itself is what must go through the editor. When a change spans many files, do the edits one at a time with the editor rather than reaching for a loop; if that is genuinely impractical, ask before scripting it. To relocate a source file, Write the content at the new path and remove the old path separately (deletion rules from [[no-rm-rf-command-form]] still apply). Do not use `git mv`, `mv`, or `mkdir + mv` chains for source files, even when content is unchanged. Related: [[pre-commit-full-diff-inspection]].
