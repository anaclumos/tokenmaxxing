# Switch verification and profiling

2026-09-10, corrections from the PR 77 adversarial review, verified by isolated CLI scenarios. Entries marked superseded describe paths that PR #81 (2026-09-12, one switching bar) or #83 (2026-09-12, parked sampling on the check tick) deleted; they stay as history, not as rules.

- Superseded by #83 (2026-09-12): a successful candidate probe changes ranking inputs, so persist and re-rank before swapping. The decision no longer probes; the check tick samples one parked account and the decision reads the cache.
- Screening exhaustion is scoped to its bar and must not enter the refresh-failure exclusion set used by reset selection.
- Superseded by #83 (2026-09-12): bound identity requests and child execution with the same abort signal, because a child-only timeout leaves HTTP retries outside the deadline. The abort plumbing went with the swap-time probe; the tick sampler runs the ordinary bounded probe.
- Superseded by #83 (2026-09-12): give verification children no refresh grant and never harvest their stripped credential back into a parked slot. The no-refresh probe mode is gone; the tick sampler refreshes through the owner-verified path like `status`.
- Superseded by #83 (2026-09-12): check refresh permission at the refresh branch itself because an identity lookup can move a token across the expiry threshold. There is no refresh permission flag any more.
- Superseded by #81 (2026-09-12): organization affinity needs headroom in the session, aggregate weekly and gated model windows. Organization affinity no longer exists.
- Superseded by #81 (2026-09-12): wall-squeeze descriptions must retain the headroom condition because default Layer 2 candidates receive no organization preference. The wall squeeze no longer exists.
- Superseded by #81 (2026-09-12): the automatic greedy path stays within the incumbent organization, while manual switching retains pure pace ranking. Automatic and manual switching now share one pace ranking.
- Superseded by #81 (2026-09-12): filter greedy candidates before ranking so an ineligible outside-organization winner cannot suppress a useful move within the organization. There is no organization filter.
- Sample freshness and probe availability are different facts, so a failed tick sample must remain visible in the log and cannot prove a target safe.
- Timestamp-filter the request corpus, deduplicate messages, and separate temporal association from causation before quoting cache overhead.
- API price weights do not establish subscription quota accounting.
- A local test stub must remain reachable until all test children finish, with external network access denied throughout.

See [switching policy](../../docs/content/docs/switching.mdx) and [measurement report](../../docs/content/docs/switching-profile.mdx).
