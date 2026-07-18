---
name: linux-boxes-track-npm
description: Mac runs tokenmaxxing from the repo working tree; the Linux boxes run the npm global install - version skew is the first thing to check for works-on-Mac-not-Linux reports
metadata:
  type: project
---

The Mac's `~/.config/tokenmaxxing/bin/tokenmaxxing` shim execs `bun run ~/Developer/tokenmaxxing/src/main.ts` (the repo working tree - every local edit is live instantly). [[linux-arm-host]] and [[linux-x86-host]] exec `~/.bun/install/global/node_modules/tokenmaxxing/src/main.ts` (the bun GLOBAL install, which only changes on `bun add -g tokenmaxxing@<ver>`). On 2026-07-12 both Linux boxes were silently two releases behind (0.4.0 vs 0.6.0) - "auto switch works on Mac, not Linux" was partly just version skew.

**Why:** releases publish via GitHub release event -> CI npm trusted publishing; nothing updates the boxes.
**How to apply:** when Linux behavior diverges from Mac, FIRST compare `grep version ~/.bun/install/global/node_modules/tokenmaxxing/package.json` on the box against the repo. To update a box: `bun remove -g tokenmaxxing && bun add -g tokenmaxxing@<ver>` (a plain `bun add -g <tarball>` over an existing install fails with DependencyLoop). Shim paths survive the reinstall; running supervisors pick the new code up on next spawn (hooks/statusline spawn fresh per invocation).
