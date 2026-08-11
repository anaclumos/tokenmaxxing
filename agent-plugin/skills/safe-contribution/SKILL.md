---
name: safe-contribution
description: Safely change and ship tokenmaxxing (tests, PR window, Mac vs Linux skew, public-repo hygiene). Use when editing this repo, opening PRs, or verifying decision-path changes.
---

# Safe contribution

## Verify

- Default suite: `bun test`.
- After decision-path changes, also run `bun test/e2e/swap-concurrency.ts` by hand (not part of `bun test`).
- Hermetic CLI: `TOKENMAXXING_HOME=/tmp/xx-test bun run src/main.ts ...`.
- Ask before any run that meters real quota (`status --force`, live-pool inference). Free `/usage` / plain status is fine.

## Ship

- Work on a branch; bump `package.json` in the same PR; open PR; wait the full review window; handle every review; merge; `gh release create v<version>`; verify npm publish.
- Never push directly to main. npm trusted publishing is bound to workflow filename `ci.yml`.

## Machine gotchas

- The owner's Mac may run this working tree live. Do not kill sessions or supervisors without asking.
- Linux boxes often run an older npm global: compare installed version before "works on Mac not Linux" debugging.
- Repo is PUBLIC: no Slack IDs, device info, or secrets in commits, PRs, docs, or `.memory`.
- Do not reintroduce banned patterns listed in `AGENTS.md` (Stop text-sniff failsafe, rejected statusline formats, old-state shims).

See [references/ship.md](references/ship.md).
