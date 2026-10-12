---
paths:
  - "src/lib/pi.ts"
  - "src/lib/piauth.ts"
  - "src/entries/pisupervisor.ts"
  - "src/lib/codex.ts"
---

# pi

pi is a client of the Claude and Codex pools, not a pool: a pi session runs on a pooled account through that account's pi store. Verified mechanics are in `.memory/pi.md`; the user page is `docs/content/docs/pi.mdx`.

- An account needs a pi login of its own in `pi-stores/<claude|codex>/<uuid8>/auth.json`, written once by `auth --pi` and refreshed afterwards by pi alone. Never fill it from the Claude Code or codex grant, and never symlink one pi `auth.json` into two stores: pi locks the path it opened (`realpath: false`), so two links to one file race a refresh. Never link a `*.lock` entry into a store either: the lock is a directory beside the path pi opened, and a linked lock dangles once released and reads as held forever.
- A Codex account held by a pi session carries one presence record, its supervisor's, so that supervisor passes its id as `holder` to `observeCodex` and refreshes the account's codex store token when it expires; every other reader still refuses a refresh while any presence record names the account.
- The supervisor's seat watch is the only move trigger, because pi runs no shell hooks (only TypeScript extensions, and the agent plugin surface stays deleted). Moves go through `piMovers[pool]`: the pool's provider with `swap` checking the target's pi store, so `decide.ts` stays provider-blind.
- A pi session's presence goes to the pool's own presence directory (`live/` or `codex-live/`), so Claude placement counts it and a Codex account holding it is exclusive.
- `--session-id <id>` opens the project session with that id or creates it, and pi writes no session file until the first reply lands; a relaunch sends `--session-id` with the resume prompt when the file exists, and repeats the first launch, first message included, when it does not (no tool has run yet, so the repeat is safe). `VALUE_FLAGS`, `BOOLEAN_FLAGS`, and `UNMANAGED_FLAGS` in `src/entries/pisupervisor.ts` follow pi's `dist/cli/args.js` (the `binary-bump-audit` skill audits them on each pi bump): pi consumes the next token for an unknown long flag unless it starts with `-` or `@`.
