# The release job

Tool facts the `publish` job in `ci.yml` is written around. Policy is in AGENTS.md "Release and CI".

- `npm pack --dry-run --json` prints an object keyed by package name on npm 12 and an array on npm 11, so the job reads the `files` list through a `..` recursion that accepts both, with `-e` to fail the step when it finds none.
- `npm view tokenmaxxing@<version> version` exits 1 with `E404` for an unknown version, which no exit code separates from a network failure, so the job reads the `versions` list once and searches it structurally.
- `npm version <bump> --no-git-tag-version` rewrites `package.json` only and prints `v<version>`. `bun.lock` carries no root version, so the release commit leaves `--frozen-lockfile` working.
- `git tag --contains` and `git diff <tag> HEAD` need the tags and their history, which `actions/checkout` fetches only with `fetch-depth: 0`.
- A concurrency group holds at most one pending run: a newer run cancels the older pending one, and the newest run checks out the newest merge, so the content of a cancelled run is released by the run that replaced it.
