---
name: release
description: Merge a tokenmaxxing pull request and verify the npm release the merge makes. Use before merging a pull request in this repository, when checking whether a merge published, when a publish job failed, or when installing a local build as the Bun global.
---

# Release

The global `ship` skill runs the loop. This skill holds what differs in this repository.

1. Read `.claude/rules/ci.md`: it holds what the `publish` job does on a push to main, which files are packed, and how concurrent publish jobs resolve.
2. Never push work directly to main. Squash merge the pull request yourself at the first clean round, never a merge commit, a rebase, or auto-merge; this repository merges its own pull requests.
3. When the merge changes a packed file, verify the release by watching the `publish` job on the merge commit's CI run (`gh run watch`), then `npm view tokenmaxxing version`. A green merge is not a publish. A merge that changes no packed file is shipped by the merge alone and never gets a forced bump.
4. When a publish job pushed its release commit and then failed to publish, the next push to main, or `gh workflow run ci.yml --ref main`, publishes that version (`ci.md` has the cases).

## Tool facts

- `gh release create --target` takes a branch name or a full commit SHA; a short SHA fails with HTTP 422.
- `bun add -g <local .tgz>` over an existing global errors `DependencyLoop`. Run `bun remove -g` first. A registry version installs over the global without it.
