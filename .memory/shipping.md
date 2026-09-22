---
name: shipping
description: The ship loop's procedure beyond the rules in AGENTS.md - gh auth check, REST polling, unfiltered review collection, threaded replies, provider-outage handling, commit identity and signing fallback, docs deploy verification
metadata:
  type: project
---

The rules (branch, PR, CI, the ten quiet minutes babysat every minute, every review handled, squash merge, the `publish` job as the release, teardown) are in `AGENTS.md` "Release and CI". This is the procedure that keeps a loop from stalling.

- Confirm `gh auth status` before the loop starts and again before the window ends. When it fails, read the PR over unauthenticated REST, stop before the merge, and ask the owner; never run `gh auth login` and never search files or process environments for a token.
- Poll over REST, never GraphQL: `gh api repos/<owner>/<repo>/pulls/<n>`, `.../pulls/<n>/reviews` (the only endpoint that returns review bodies), `.../pulls/<n>/comments`, `.../issues/<n>/comments`, `.../commits/<sha>/check-runs`, `.../commits/<sha>/status`, and `.../issues/<n>` for the source issue. `gh api graphql`, `gh pr view --json`, `gh pr checks`, and `gh pr merge` all spend the per-user GraphQL quota, which the owner's other sessions share, and `gh api rate_limit` does not show the exhaustion. Merge over REST too: `gh api -X PUT .../pulls/<n>/merge` with `merge_method` `squash` and the head `sha`, so a moved head cannot merge. Keep one GraphQL read for the final review-thread check.
- Collect reviews unfiltered every round: every inline comment and every review body, filtered by timestamp only, never by author. A withheld approval can name its finding only in the review body.
- Answer every inline finding as a threaded reply on that comment (`.../pulls/<n>/comments/<id>/replies`) with the fixing SHA or the refutation. A PR-level comment is not handling.
- A review bot red on its own provider is not a finding: the run log says the usage limit was reached, no review body and no inline comment was posted, and reruns fail the same way. Read `gh run view <id> --log-failed` before treating any red check as a blocker, record the outage in a PR comment, and keep the quiet clock on the bots that did run. Main has no required checks; the ship rule is the gate.
- Schedule periodic wakeups through every wait; never rely on a background shell or monitor alone. Keep poll scripts and their state out of `/tmp`, which a reboot clears.
- Read the full staged diff untruncated before every commit, bulk and agent-generated changes included. A stat plus greps is not the read.
- Some hosts have no `git user.name`. Pass `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` per commit with the identity the repo's recent commits carry; never write git config, because worktrees share `.git/config` with the owner's checkout. No AI attribution trailers.
- A vault-backed SSH signing agent that has locked fails every commit with `failed to fill whole buffer`, and retries only queue unlock dialogs. The owner authorized `--no-gpg-sign` as the standing fallback: attempt the signed commit once, fall back, and note the fallback in the commit body. Squash merges are signed by GitHub regardless.
- A docs change ships when the GitHub production deployment for the merge commit reports `success` (`gh api repos/<owner>/<repo>/deployments`, the Production entry whose `ref` is the merge SHA, then its statuses). The Vercel URLs are SSO-protected, so no page fetch proves anything; `cd docs && bun run build` is the content check.
