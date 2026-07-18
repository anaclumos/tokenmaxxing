---
name: macos-no-bin-true-probe-recursion
description: macOS has no /bin/true (only /usr/bin/true); a missing claudeBin used to make resolveRealClaude PATH-scan its way to the installed tokenmaxxing wrapper and recurse into a forever-hung /usage probe
metadata:
  type: project
---

Verified 2026-07-12 on macOS 26.5: `/bin/true` does not exist (`/usr/bin/true` does). The swap e2e seeded `claudeBin: "/bin/true"`, so on macOS `resolveRealClaude` fell through to its PATH scan, whose recursion guard only skips `paths.binDir` under the CURRENT (relocated, test) `TOKENMAXXING_HOME` - it happily returned the user's real installed wrapper `~/.config/tokenmaxxing/bin/claude`. The probe then spawned `__supervise -p /usage`, which launched the real claude against an empty temp CLAUDE_CONFIG_DIR and hung forever (probeUsage had no timeout), silently wedging the e2e for 15+ minutes.

**Why:** two stacked hazards: (1) any hardcoded `/bin/true` in tests breaks on macOS; (2) a configured-but-missing claudeBin silently degrading to a PATH scan can resolve to tokenmaxxing itself whenever TOKENMAXXING_HOME is relocated.

**How to apply:** use `/usr/bin/true` in tests (exists on macOS and usr-merged Linux). `resolveRealClaude` now throws on a configured-but-missing claudeBin instead of PATH-scanning, and `probeUsageOnce` kills the child after 60s (PROBE_KILL_MS) so a wedged probe can never block a Stop hook. Fixed in the 2026-07-12 switch-simplification change; see [[tokenmaxxing-project]]. Caveat learned 2026-07-13: the 60s kill alone was NOT sufficient - descendants inherit the stdout pipe and the read blocked past the kill; see [[supervisor-recursion-guards]] for the full 0.6.2 guard set (depth sentinel, verified pinning, pipe-read grace).
