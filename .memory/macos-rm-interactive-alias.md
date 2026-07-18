---
name: macos-rm-interactive-alias
description: On the user's macOS box, rm is aliased to rm -i; non-interactive shells silently skip deletion but still exit 0
metadata:
  type: user
---

On the user's Mac, `rm` is aliased to `rm -i` (zsh profile). In a non-TTY shell the confirmation prompt gets EOF, `rm` deletes nothing, and it still exits 0, so `rm file && echo ok` lies.

**Why:** A "successful" delete that didn't happen broke the claude-hud removal on 2026-07-11 until verification caught the still-existing file.

**How to apply:** Always pass `-f` (or use `command rm`) when deleting files in Bash tool calls on this machine, and verify the path is gone afterward.
