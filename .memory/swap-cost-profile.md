---
name: swap-cost-profile
description: 2026-09-10 measurement of what account swaps cost in prompt-cache re-uploads (13 days of local Claude Code transcripts joined to the swap log), the refuted probe-burn hypothesis, the two fixes it drove (organization-first ranking, pre-swap live verification), and the open architectural fork (one shared credential = correlated blast radius)
metadata:
  type: project
---

Owner hypothesis (2026-09-10): the switching strategy "burns and wastes too many tokens and busts caches all the time, draining usage too fast." Measured against every local Claude Code transcript modified 2026-08-28 to 2026-09-09 joined to the `swap.done` lines of the tokenmaxxing log. Method: dedupe assistant rows by message id (one row per API request), sort per session, call a request a cache bust when the previous request's context was at least 20k tokens, the new request read back less than half of it from cache, and re-wrote at least half of it. Attribute a bust to a swap when a `swap.done` falls between the two requests or within 120 seconds before the busting request (macOS adopts a swapped credential up to 30 seconds late, so the first request after a swap often still carries the old token), and only when the gap is under one hour (the main-conversation cache TTL). Weights are the published multipliers: 1-hour cache write 2x, 5-minute write 1.25x, cache read 0.1x, Fable read 0.025x.

**Numbers (13 days, 10,999 transcript files, 198,637 requests).**

| Measure | Value |
| --- | --- |
| Cache reads / cache writes / uncached input / output | 33.9B / 1.13B / 6.1M / 114M tokens |
| Cache writes at 1h TTL (main conversation) / 5m TTL (subagents) | 162M / 968M |
| Swaps in window (cross-org / same-org) | 280 (249 / 31); the pool is 15 accounts in 9 organizations, one org holding 7 seats |
| Hot sessions at swap time (context at least 20k, request in the prior 10 min) | mean 22, median 12, p90 52, max 246; 57 swaps hit no hot session |
| Busts attributed to swaps | 1,508 busts, 273M context tokens re-uploaded, 380M weighted units |
| Share of all weighted input | 8.7% (7.7% with output weighted 5x); worst single day 13.8%; worst 5-hour buckets 18.5%, 17.8%, 17.0%, 15.5% |
| Per swap with attributable cost (182 of 280) | median 1.7M, mean 2.1M, p90 4.3M, max 9.3M weighted units |
| First request after a cross-org swap that busts / the request after that | 23.0% (n=2,496) / 47% |
| First request after a same-org swap / the request after that | 12.9% (n=240) / 7% |
| Control, no swap within 30 minutes | 5.7% (n=1,476) / 1.6% |
| Busts not caused by swaps (compaction and prefix changes 657, TTL expiry 20, model change 8) | 165M weighted units; all busts together 12.6% of weighted input |
| Under flat token counting instead of cost weights | swap busts are 0.78% of all tokens |

**Conclusions.** The cache-bust half of the hypothesis holds: a cross-org swap makes almost every hot session re-upload its context, and on a heavy day that is a double-digit share of the 5-hour window, which matches the owner's "30% of 5h" feel as a spike, not an average. A same-org swap busts near the baseline, so the cache really is organization-scoped in practice as well as in the docs (platform.claude.com prompt-caching: "Caches are isolated between organizations"; per workspace within an org on the Claude API). The token-burn half is refuted for the probe: `claude -p '/usage'` is a local command (`supportsNonInteractive: true` in 2.1.266), its transcripts carry no assistant row, and the header text the log recorded 6,745 times as `usage.probe_unparsed` is a hardcoded string printed when Claude's own usage fetch fails silently. The probe wastes CPU and litters `~/.claude/projects/-/` with 4,488 empty transcripts, but spends no quota. The drain itself is mostly the workload: Claude Code's own `/usage` attribution on 2026-09-10 read "59% of your usage was at >150k context" and "100% ... from subagent-heavy sessions."

**Swap-count anatomy.** 167 of 292 swaps had no trigger line within 3 seconds (the hard path and manual `switch` logged nothing; both do now). 92 greedy, 17 wall squeezes, 63 depleted pre-parks, about 15 StopFailure-driven. 22 swaps landed within 60 seconds of the previous one, 109 within 5 minutes, and 42 were A to B and back to A inside 30 minutes. The worst chains were the wall squeeze hopping four accounts in four minutes (2026-09-08 15:35) and depleted thrash between two walled accounts (2026-09-09 16:28), both driven by parked samples that said under-bar while the server said 100, because other hosts drain the same accounts.

**Fixes shipped (1.20.0).** `swapPreference` ranks the seat's own organization first, pace pressure within the tier, so the greedy path never crosses orgs while the seat is usable and the hard path crosses only when no same-org seat is usable. Every automatic swap verifies a candidate whose sample is older than `usagePollTtlMs` with one free `/usage` probe of its parked credential and skips it for the evaluation when it is really over a bar. Details in [[switch-policy-pace-pressure]].

**Open fork, owner decision.** The multiplier behind the cost is the shared live credential: one swap moves every session, so a swap costs N busts for N hot sessions, and N averaged 22. Per-session credential isolation (a `CLAUDE_SECURESTORAGE_CONFIG_DIR` per seat, set by the supervisor, so each session adopts only its own account's rotations and new sessions start on the least-loaded account) would cut bust count by roughly N and spread the 5-hour windows across accounts. It is a redesign of the credential store, the swap, the hooks, and the status surface, so it was surfaced, not built. Also not built: skipping the wall squeeze when its expected re-upload exceeds the 2 to 5 percent it recovers, and pacing the timer probe off when the tee is fresh.

**How to apply:** re-run the profile before changing the ranking again; the scripts are a 60-line Python join of `~/.claude/projects/**/*.jsonl` against `tokenmaxxing.log`, and the same-org versus cross-org first-request test is the decisive check for any claim about cache scope. Keep account labels and emails out of any output that leaves the machine ([[account-labels-are-pii]]).
