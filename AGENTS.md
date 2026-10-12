# Agent rules

Repo-specific rules only. The owner's global agent rules load beside this file in every session; where this file is silent, the global rule applies. Claude Code reads `AGENTS.md` where a project has no `CLAUDE.md`. Long-form detail lives in `DESIGN.md` and `docs/content/docs/`. A durable lesson that no code or doc shows goes to `.memory/`, this repository's named exception to the global no-`.memory` rule (Agent Memory Repo format: one snake_case file per subject, one bullet per entry, `MEMORY.md` as the index, public bar), written as the rule that prevents the next mistake, never as a narrative. A repo gotcha goes there only, never also to Supermemory; the exit interview and every other global Supermemory write still apply. A line here or in a rule file is a repo-specific trap that is still true and not visible from the code an agent is about to touch; otherwise link instead of inlining, because a duplicated fact rots.

## Rules and skills

Subtree law lives in `.claude/rules/`, one file per subsystem, each scoped by its `paths` frontmatter. Claude Code loads a rule when it reads a matching file; a harness that does not (Codex) reads the rule whose paths match before it edits there.

- `credentials.md`: credential stores, identity, onboarding, dead grants, grok quota.
- `switching.md`: the decision engine, ranking, bars, screening, sampling, banked resets, model families.
- `supervisor.md`: the respawn marker, the live session id, compaction, the relay, the seat watch, the stream-json tee.
- `claude-internals.md`: the usage read, the tee, StopFailure classification, real-binary spawns.
- `codex.md`, `pi.md`, `api-keys.md`, `self-update.md`, `statusline.md`, `cli-output.md`, `hub.md`.
- `code.md`: code-wide constraints, platform idioms, and the designs that stay deleted, for all of `src/`.
- `ci.md`: `ci.yml`, the publish job, the runners, the Nix build. `docs-site.md`: the docs app.

Procedures are skills in `.claude/skills/`: `release` (this repo's ship deltas and release verification), `hermetic-runs` (how to verify a change), and `binary-bump-audit` (the tables to audit when claude or pi updates).

## The project

tokenmaxxing pools the owner's own Claude Code and Codex logins, starts each session on its own pooled account, moves a session to a fresher account as its account nears the 5-hour or weekly limit, and keeps sessions continuable across moves. Design: `DESIGN.md`. User docs: `docs/content/docs/`.

No external installed user base, so this is pre-production code: delete old-state compatibility rather than carry it forward.

## Safeguards and machine gotchas

- Resolve the installed entry point before assuming a checkout is the active runtime: the installed shim, hooks, statusline, and check timer run the Bun global install, so a fix verified with `bun run src/main.ts` is not live until the owner reinstalls the global.
- The owner's hosts run live supervisors, hooks, the periodic check, and real claude sessions. Never kill a running session or supervisor to free a resource without asking.
- The owner's hosts are managed environments: never run `init`, `add`, `auth`, `uninstall`, or anything that writes settings.json, launchd/systemd units, shell rc, or the global package on a live host. Ship code; activation is the owner's step.
- The working tree is a shared checkout. Stage commits by explicit path, never `git add -A` or `-u`. Read an old version with `git show <ref>:<path>`, never `git checkout <ref> -- <path>`. Relocate a source file by writing the new path and removing the old one, never `git mv`.
- No dynamic workflows on this repo: never orchestrate through the Workflow tool or any scripted fan-out. Spawn every subagent by hand, one Agent call per subagent with a prompt crafted for that task, every file it may touch as an absolute path. Every subagent brief names the verbs the seat may not run (`init`, `add`, `auth`, `uninstall`, `status --force`, anything that writes under `HOME`); "hermetic" is not enough, and an explicit allow beats an implicit deny.
- Never print credential material: keychain blobs, `.credentials.json`, `auth.json`, OAuth access or refresh tokens. Report account labels and status only. A ky error carries its request, Authorization header included. A supervised harness session's argv carries its bearer in `--mcp-config`, so pipe any argv, env, or config dump through a Bearer redactor; truncation is not a safeguard.
- Ask before any run that meters real quota or opens a session window on a pooled account. A feature request is not permission to spend. Free usage reads are fine. Dev hosts log in with the pooled accounts, so a Fable fan-out and a Codex consult are spend against the pool too. The one adversarial review per unit of work that the global rules require is a standing mandate and needs no ask.
- This repo is PUBLIC. PR bodies, commit messages, review replies, release notes, docs, and `.memory` hold no workspace chat content or link, host path, hostname, device name, or host configuration.
- Pool account labels are personal data, the same as emails and organization names: the owner names seats after people. Never paste `status`, `doctor`, or log output that carries labels, emails, or org names into a PR body, commit, review reply, doc, memory, or subagent prompt. Mask or count them ("six team seats", "15 accounts").
- For platform-specific behavior differences, compare the installed package versions before attributing the difference to the platform.
- A prior go-ahead does not cover collision evidence that arrives after it. Every new signal of concurrent work freezes git actions until the owner rules.
- Never write a completion claim into docs or memory ahead of the output that proves it.
- Ask before running the live interactive-PTY SIGTERM test (`DESIGN.md` §9).
- These rules bind advice and host actions, not only edits: never copy a credential between stores or between hosts (`credentials.md`); never point a consumer at `codex-stores/` directly, and never recommend it (`codex.md`); subagents cannot run on another pooled account, and `claude setup-token` stays abandoned (`claude-internals.md`).

## Shipping and verification

- Never bump `package.json` in a PR: CI assigns the version at merge time, so sibling PRs cannot collide on it. A merge that changes a packed file is shipped only when its publish lands; a merge that changes no packed file (`docs/`, `.memory/`, `.github/`, `.claude/`, `AGENTS.md`) is shipped by the merge alone and never gets a forced bump. This repo merges its own PRs. Load the `release` skill before a merge. Detail: `.memory/shipping.md`.
- The repo carries no test code and names no end-to-end target. Do not add test files, a test script, or a test CI step. Verification is the typecheck in the CI `test` job on the pushed head plus hermetic CLI runs under a throwaway `TOKENMAXXING_HOME` and free live reads; a mutating command runs only under a full isolated `HOME` with `TOKENMAXXING_SKIP_TIMER=1`, or in a container. Load the `hermetic-runs` skill before any such run.
