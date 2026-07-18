---
name: bun-tcc-appdata-prompts
description: macOS 26 "bun would like to access data from other apps" prompts come from the tokenmaxxing check launchd agent; fix is granting bun Full Disk Access
metadata:
  type: project
---

On the user's Mac (macOS 26.5.2), recurring TCC dialogs saying "bun would like to access data from other apps" (first reported 2026-07-12) are caused by the tokenmaxxing periodic check:

- `com.tokenmaxxing.check` launchd agent fires every 180s and runs `~/.config/tokenmaxxing/bin/tokenmaxxing check`.
- On the Mac that "binary" is a dev shim: `exec ~/.bun/bin/bun run ~/Developer/tokenmaxxing/src/main.ts` (see [[linux-boxes-track-npm]]: Mac tracks repo). The launchd job's root executable is therefore plain `bun`, so macOS attributes every TCC request from the job (including children) to "bun".
- The check spawns `claude -p /usage --output-format json` (src/lib/usage.ts) nearly every run (`usagePollTtlMs` 90s < 180s interval), and the claude CLI is known upstream to touch other apps' protected data (anthropics/claude-code issues #63130, #36832, #36675: unstable per-version binary identity, no app bundle).
- The system TCC db has `kTCCServiceSystemPolicyAllFiles | ~/.bun/bin/bun | 0` (Full Disk Access DENIED, i.e. bun is listed in the FDA pane but toggled off), so App Data prompts keep re-firing; the user-level `kTCCServiceSystemPolicyAppData` row (auth_value 5, semantics not well documented) does not stop them.

**Fix:** toggle `bun` ON in System Settings > Privacy & Security > Full Disk Access (it is already in the list). Scoped alternative: install a compiled tokenmaxxing binary signed with a stable (non-ad-hoc) identity + Info.plist and grant that FDA instead. Clicking Allow on the dialog itself does not durably persist for path-identified CLI clients.
