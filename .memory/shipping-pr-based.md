# Shipping is PR-based

User decision 2026-07-18 (Slack, #tokenmaxxing-dogfooding thread): "shipping will now be PR-based". Supersedes the direct-push-to-main flow used through 0.18.0.

- Completed work reaches main only through a pull request: work on a branch, commit there, push the branch, `gh pr create`, make CI pass, handle every review comment, merge when all clear.
- Never push work directly to main.
- Releases: the version bump lands on main via a PR first, then `gh release create v<version>` as before (ci.yml publish via trusted publishing is unchanged).
- The standing "commit and push after each verified milestone" rule still holds, but pushes go to the work branch.
- Canonical rule text lives in AGENTS.md "Release and CI" (first bullet).
