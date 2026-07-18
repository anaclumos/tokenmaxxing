---
name: linux-arm-host
description: the owner's Raspberry Pi (ssh alias in their local ssh config), the ARM Linux test host for tokenmaxxing; has Claude Code + a live max account
metadata:
  type: reference
---

The ARM Linux test box (ssh alias in the owner's local ssh config; BatchMode works) = Raspberry Pi, Debian 13 trixie, aarch64, 16GB RAM, NVMe. The real-hardware Linux test host for [[tokenmaxxing-project]] (user chose it over the Docker container, 2026-07-09).

State as of 2026-07-12: Claude Code 2.1.207 at `~/.local/bin/claude`, a 4-account pool (four of the owner's own accounts), tokenmaxxing 0.6.1 from npm global (see [[linux-boxes-track-npm]]; the old `~/tokenmaxxing` rsync copy is gone). Bun 1.3.14 at `~/.bun/bin/bun`. Supervisor + hooks + statusline + systemd check timer all installed and verified working. `node` is absent (plugin SessionEnd hooks print failures - harmless). PATH line NOT in shell rc - the zshrc is a shared dotfiles repo, left to the user. Machine runs the user's real claude sessions - never disturb running sessions or reset state without asking.
