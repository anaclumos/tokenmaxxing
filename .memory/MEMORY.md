# Memory index

- [git show, not checkout, for reads](git-show-not-checkout-for-reads.md) - hook correction 2026-07-18: never `git checkout <ref> -- <file>` to read an old version (it overwrites the shared working copy); use `git show <ref>:<path>` / `git diff <refA>..<refB> -- <path>`
- [Shipping is PR-based](shipping-pr-based.md) - user 2026-07-18: completed work reaches main only via a PR (branch, push, gh pr create, CI green, review handled, merge); never a direct push to main; supersedes the direct-push flow used through 0.18.0
- [xx serve slackbot decisions](serve-slackbot-decisions.md) - user 2026-07-18: Chat SDK only (EVE dropped), Socket Mode local daemon, worktree-per-thread; LIVE-VERIFIED 2026-07-18 incl. the socket-lifecycle root cause (never loop startSocketModeListener), prefixed ids, native cards + segment breaks, yolo/AskUserQuestion, queue TTL folding

- [Live pool runs need permission](live-pool-runs-need-permission.md) - ask before any run that meters quota or starts a session window on real accounts; hermetic tests + free /usage reads only by default

- [tokenmaxxing project goal](tokenmaxxing-project.md) - CLI pooling Claude Code/Codex accounts, hot-swap on quota; npm name owned by user (anaclumos); latest ships: 0.19.0 RELEASED 2026-07-18 (serve live fixes + native streaming + subagent tool cards; first PR-based ship, PR #6), 0.19.1 2026-07-18 (serve restart resilience: startup re-subscribe, drain, dead-segment recovery, PR #8); .memory git-tracked since 2026-07-18
- [CC/Codex auth mechanics](cc-codex-auth-mechanics.md) — verified keychain/CODEX_HOME/quota internals both CLIs depend on; see DESIGN.md §2
- [Per-model weekly caps](cc-per-model-limits.md) — per-model weekly limits exist only for Sonnet and Fable, no Opus-only quota (user 2026-07-12); only Fable gates a switch ("fable=switch, sonnet=ok")
- [ARM Linux host](linux-arm-host.md) - the owner's Pi: the Linux test box; claude 2.1.207, 4-account pool, tokenmaxxing 0.6.1
- [x86 Linux host](linux-x86-host.md) - the owner's Fedora box: 4-account pool; bun/xx under ~/.bun/bin; Linux claude prints comma reset-clock glue
- [Switch policy: pace pressure](switch-policy-pace-pressure.md) - user decisions 2026-07-13 + 2026-07-16: rank by pacePressure (furthest behind own weekly pace first); hooks/timer engage greedily at 50% session (greedySessionFloor), thresholds are screening-only bars (session 95 / weekly 98) via effectiveBars; shipped v0.7.0 + v0.10.0
- [/usage after switch observation](usage-after-switch-live-observation.md) - RESOLVED: user was right, running claude sessions adopt external cred swaps in <=30s on macOS (immediately on Linux); the old no-hot-swap claim was a verification error, corrected in cc-codex-auth-mechanics
- [macOS rm -i alias](macos-rm-interactive-alias.md) - rm is aliased to rm -i on the Mac; non-TTY deletes silently no-op yet exit 0, so use rm -f and verify
- [Native statusline settled](statusline-replacement-in-progress.md) - 2026-07-18 redesign: quota as truecolor ramp color not numbers, model name carries ctx fill, 𝒇 fable initial, every account shown (no counted collapse), earliest-reset order, subagentStatusLine panel rows
- [macOS lacks /bin/true; probe recursion hazard](macos-no-bin-true-probe-recursion.md) - use /usr/bin/true in tests; configured-but-missing claudeBin now fails fast instead of PATH-scanning to the wrapper; probes get a 60s kill guard
- [Linux boxes track npm, Mac tracks repo](linux-boxes-track-npm.md) - check version skew FIRST on works-on-Mac-not-Linux reports; bun remove -g before adding a tarball
- [Headless decision freshness invariants](headless-decision-freshness.md) - v0.6.1 fix set: snapshot TTL refresh, unknown model gates all families, mtime heartbeat, 45s cooldown, anticipatory-only pre-park
- [bun TCC App Data prompts](bun-tcc-appdata-prompts.md) - recurring "bun would like to access data from other apps" = check agent probing claude every 3 min; fix: toggle bun ON in Full Disk Access
- [Agent SDK auth surface](agent-sdk-auth-surface.md) - verified 2026-07-16 for the v0.11.0 SDK task: per-query CLI subprocess, no hot-swap, pathToClaudeCodeExecutable/env/resume hooks; ToS blocker on subscription-OAuth pooling - ask user before building
- [Supervisor recursion guards](supervisor-recursion-guards.md) - 2026-07-12 ~1800-process self-spawn (poisoned claudeBin pin); 0.6.2 layered guards: depth sentinel, realpath identity, verified pinning, probe pipe-race
- [Credential-dir cleanup rule](credential-dir-cleanup-rule.md) - user 2026-07-16: onboard homes holding plaintext creds are hard-deleted (rmSync), the one exception to the trash safeguard
- [No rm -rf command form](no-rm-rf-command-form.md) - the ban is on the command form itself; session temporaries may be deleted but never via rm -rf (fresh dir names or trash instead)
- [xx quota chart labels](xx-quota-chart-labels.md) - user rule 2026-07-17: chart labels all lowercase ("5h", "week", "spark", "fable"; Titlecase "Week" tried and reverted); OpenAI's GPT-5.3-Codex-Spark cap maps via codexLimitLabel, never exact strings
