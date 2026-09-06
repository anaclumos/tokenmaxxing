---
name: linux-x86-host
description: the owner's Fedora box (ssh alias in their local ssh config); 9-account Claude pool on the bun global (1.15.0 as of 2026-09-06); the owner's scheduled jobs on the Linux hosts call the status flags, so a flag rename is followed by updating them; bun/tokenmaxxing under ~/.bun/bin (not on non-interactive ssh PATH)
metadata:
  type: project
---

The x86 Linux box (ssh alias in the owner's local ssh config): Fedora 44 x86_64 host running claude at `~/.local/bin/claude` (the configured `claudeBin`) and a live 9-account Claude pool plus one Codex account (state in `~/.config/tokenmaxxing`); tokenmaxxing 1.15.0 from the bun global as of 2026-09-06 (see [[linux-boxes-track-npm]]). The Linux hosts also run scheduled jobs of the owner's own that call the `status` flags, so a rename of those flags is followed by updating each host's jobs in the same ship. `bun` and the `tokenmaxxing`/`xx` shims live in `~/.bun/bin` and `~/.config/tokenmaxxing/bin`, which are NOT on the non-interactive ssh PATH: use absolute paths. `node` is absent (plugin SessionEnd hooks fail there). This box is where the missing-reset-timeline bug reproduced (2026-07-10): its claude prints the reset clock with comma glue (`Jul 10, 3:30pm`) while macOS prints ` at ` glue, i.e. the two OS builds of the same claude version format `/usage` clocks differently. See [[linux-arm-host]] for the other Linux box.
