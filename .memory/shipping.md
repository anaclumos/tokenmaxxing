# Shipping

The ship rules (branch, PR, CI, every review handled, squash merge, the `publish` job as the release, teardown) are in `AGENTS.md` "Release and CI". These entries keep a loop from stalling.

- Confirm `gh auth status` before the loop starts and again before the merge; when it fails, read the PR over unauthenticated REST, stop before the merge, and ask the owner. Never run `gh auth login` and never search files or process environments for a token.
- Poll over REST, never GraphQL: `gh api repos/<owner>/<repo>/pulls/<n>`, `.../pulls/<n>/reviews` (the only endpoint that returns review bodies), `.../pulls/<n>/comments`, `.../issues/<n>/comments`, `.../commits/<sha>/check-runs`, `.../commits/<sha>/status`, and `.../issues/<n>` for the source issue.
- `gh api graphql`, `gh pr view --json`, `gh pr checks`, and `gh pr merge` all spend the per-user GraphQL quota that the owner's other sessions share, and `gh api rate_limit` does not show the exhaustion; keep one GraphQL read for the final review-thread check.
- Merge over REST: `gh api -X PUT .../pulls/<n>/merge` with `merge_method` `squash` and the head `sha`, so a moved head cannot merge.
- Collect reviews unfiltered every round: every inline comment and every review body, filtered by timestamp only, never by author, because a withheld approval can name its finding only in the review body.
- Answer every inline finding as a threaded reply on that comment (`.../pulls/<n>/comments/<id>/replies`) with the fixing SHA or the refutation; a PR-level comment is not handling.
- Main has no required checks, so the ship skill's clean round is the only merge gate.
- Schedule periodic wakeups through every wait and never rely on a background shell or monitor alone; keep poll scripts and their state out of `/tmp`, which a reboot clears.
- Read the full staged diff untruncated before every commit, bulk and agent-generated changes included; a stat plus greps is not the read.
- Some hosts have no `git user.name`: pass `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` per commit with the identity the repo's recent commits carry, and never write git config, because worktrees share `.git/config` with the owner's checkout.
- A locked vault-backed SSH signing agent fails every commit with `failed to fill whole buffer`, and retries only queue unlock dialogs; attempt the signed commit once, fall back to `--no-gpg-sign`, and note the fallback in the commit body. Squash merges are signed by GitHub regardless.
- A docs change ships when the GitHub production deployment for the merge commit reports `success` (`gh api repos/<owner>/<repo>/deployments`, the Production entry whose `ref` is the merge SHA, then its statuses).
- The Vercel URLs are SSO-protected, so no page fetch proves anything; the content check before the merge is the Preview entry for the head commit (`.../deployments?sha=<head sha>`), read the same way. A failed build posts `failure` on that entry and on the `Vercel` commit status, which keeps the merge state out of `CLEAN`, and a head with no Preview entry does not merge either.
