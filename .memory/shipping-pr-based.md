# Shipping is PR-based

User decision 2026-07-18 (Slack, #tokenmaxxing-dogfooding thread): "shipping will now be PR-based". Supersedes the direct-push-to-main flow used through 0.18.0. Refined by the user later the same day: "ship = do the work, open a PR, wait 10 minutes for reviews to kick in, handle reviews (refute or agree), then merge, tear down (clean up). tag user in slack when decision is needed or user intervention is needed."

- Ship = do the work, then land it through a pull request: work on a branch, commit there, push the branch, `gh pr create`, make CI pass.
- After opening the PR, wait 10 minutes for reviews to kick in before merging.
- Handle every review: agree and fix, or refute with a reasoned reply on the PR. Never merge over an unanswered review.
- Merge when all clear, then tear down: delete the merged branch, remove temporary worktrees and other session artifacts.
- Never push work directly to main.
- Tag the user in Slack when a decision or user intervention is needed; otherwise run the whole sequence end to end without asking.
- Releases: the version bump lands on main via a PR first, then `gh release create v<version>` as before (ci.yml publish via trusted publishing is unchanged).
- The standing "commit and push after each verified milestone" rule still holds, but pushes go to the work branch.
- Canonical rule text lives in AGENTS.md "Release and CI" (first bullet).
