# Switch verification and profiling

2026-09-10, corrections from the PR 77 adversarial review, verified by isolated CLI scenarios.

- A successful candidate probe changes ranking inputs, so persist and re-rank before swapping.
- Screening exhaustion is scoped to its bar and must not enter the refresh-failure exclusion set used by the wall squeeze and reset selection.
- Bound identity requests and child execution with the same abort signal, because a child-only timeout leaves HTTP retries outside the deadline.
- Give verification children no refresh grant and never harvest their stripped credential back into a parked slot.
- Organization affinity needs headroom in the session, aggregate weekly and gated model windows.
- The automatic greedy path stays within the incumbent organization, while manual switching retains pure pace ranking.
- Sample freshness and verification availability are different facts, so a failed probe must remain visible and cannot prove a target safe.
- Timestamp-filter the request corpus, deduplicate messages, and separate temporal association from causation before quoting cache overhead.
- API price weights do not establish subscription quota accounting.
- A local test stub must remain reachable until all test children finish, with external network access denied throughout.

See [switching policy](../../docs/content/docs/switching.mdx) and [measurement report](../../docs/content/docs/switching-profile.mdx).
