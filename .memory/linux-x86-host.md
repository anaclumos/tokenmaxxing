---
name: linux-x86-host
description: the owner's Fedora box (ssh alias in their local ssh config); tokenmaxxing initialized with 4-account pool; bun/tokenmaxxing under ~/.bun/bin (not on non-interactive ssh PATH)
metadata:
  type: project
---

The x86 Linux box (ssh alias in the owner's local ssh config): Fedora 44 (kernel 7.0.14) x86_64 host running claude 2.1.206 at `~/.local/bin/claude` and a live 4-account tokenmaxxing pool (state in `~/.config/tokenmaxxing`); tokenmaxxing 0.6.1 from npm global as of 2026-07-12 (see [[linux-boxes-track-npm]]). `bun` and the `tokenmaxxing`/`xx` shims live in `~/.bun/bin` and `~/.config/tokenmaxxing/bin`, which are NOT on the non-interactive ssh PATH: use absolute paths. `node` is absent (plugin SessionEnd hooks fail there). This box is where the missing-reset-timeline bug reproduced (2026-07-10): its claude prints the reset clock with comma glue (`Jul 10, 3:30pm`) while macOS prints ` at ` glue, i.e. the two OS builds of the same claude version format `/usage` clocks differently. See [[linux-arm-host]] for the other Linux box.
