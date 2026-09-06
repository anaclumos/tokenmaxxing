---
name: safe-contribution
description: Safely change and ship tokenmaxxing (verification without a test suite, PR window, Mac vs Linux skew, public-repo hygiene). Use when editing this repo, opening PRs, or verifying decision-path changes.
---

# Safe contribution

## Verify

- The repo carries no test code and no comments (owner ruling 2026-09-02). Never add tests, a test script, or comments.
- Verify with `bun run typecheck`, then hermetic CLI runs: `TOKENMAXXING_HOME=/tmp/xx-test bun run src/main.ts ...` (for decision-path changes, write accounts.json, usage.json, config.json, and a claude.json under that root and run `check`; point `TOKENMAXXING_KEYCHAIN_SERVICE` and `TOKENMAXXING_KEYCHAIN_ACCOUNT` at throwaway names and `TOKENMAXXING_CLAUDE_JSON` at that claude.json, because the CLI resolves claude.json from HOME, not from `TOKENMAXXING_HOME`).
- Ask before any run that meters real quota (`status --ping`, live-pool inference). Free `/usage` / plain status is fine.

## Ship

- Work on a branch; bump `package.json` and `agent-plugin/plugin.json` to the same version in the same PR; open PR; wait the full review window; handle every review; merge; `gh release create v<version>`; verify npm publish.
- Never push directly to main. npm trusted publishing is bound to workflow filename `ci.yml`.

## Machine gotchas

- The owner's Mac may run this working tree live. Do not kill sessions or supervisors without asking.
- Linux boxes often run an older npm global: compare installed version before "works on Mac not Linux" debugging.
- Repo is PUBLIC: no Slack IDs, device info, or secrets in commits, PRs, docs, or `.memory`.
- Do not reintroduce banned patterns listed in `AGENTS.md` (Stop text-sniff failsafe, rejected statusline formats, old-state shims).

See [references/ship.md](references/ship.md).
