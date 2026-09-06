# Shipping is PR-based

User decision 2026-07-18 (Slack, dogfooding-channel thread): "shipping will now be PR-based". Supersedes the direct-push-to-main flow used through 0.18.0. Refined by the user later the same day: "ship = do the work, open a PR, wait 10 minutes for reviews to kick in, handle reviews (refute or agree), then merge, tear down (clean up). tag user in slack when decision is needed or user intervention is needed." WIDENED by the user 2026-07-20 ("You must also do all of those when you ship", after PR #38 merged with no release): ship always includes the release; a merge without a publish is not shipped.

- Ship = do the work, then land it through a pull request AND release it: work on a branch, bump the `package.json` version in the same PR, commit there, push the branch, `gh pr create`, make CI pass.
- After opening the PR, babysit it every minute: poll for new reviews, comments, check results, and merge state, handle each item as it lands, and merge only after 10 consecutive quiet minutes. Owner rule 2026-09-06 ("10 minutes of silence but you should babysit every minute"), replacing the fixed 10-minute timer from the last push.
- Handle every review: agree and fix, or refute with a reasoned reply on the PR. Never merge over an unanswered review.
- Merge when all clear, then release: `gh release create v<version>` (ci.yml publishes via trusted publishing) and verify the publish landed (`npm view tokenmaxxing version`). Then tear down: delete the merged branch, remove temporary worktrees and other session artifacts.
- Never push work directly to main.
- Tag the user in Slack when a decision or user intervention is needed; otherwise run the whole sequence end to end without asking.
- The standing "commit and push after each verified milestone" rule still holds, but pushes go to the work branch.
- Canonical rule text lives in AGENTS.md "Release and CI" (first bullet).
