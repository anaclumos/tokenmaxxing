# Memory index

This folder is tracked in a public repository and is the one memory store for every agent that works here: the Claude Code harness memory directory for this project is a symlink to it, and Codex reads `AGENTS.md` directly. Every note is public knowledge: no hostnames, ssh aliases, hardware, machine usernames, host paths that identify a machine, Slack details, `.env` keys, credential layout, account labels, or personal names. A note is a rule that prevents the next mistake, one file per subject, written in the present tense with no history and no dates; a binary or package version stays only where it tells the reader what to re-verify. A fact the code, `--help`, `DESIGN.md`, `AGENTS.md`, or `docs/` already shows does not belong here. Update the file that owns a subject instead of adding a second one, and delete a note the code has outgrown.

- [Claude Code internals](claude-code-internals.md) - verified store, refresh, identity, hook, and statusline mechanics the pool depends on; re-verify on each binary bump
- [Codex internals](codex-internals.md) - verified auth, usage, hook, and SDK-consumer mechanics of the Codex pool; re-verify on each binary bump
- [Shipping](shipping.md) - the ship loop's procedure beyond the AGENTS.md rules: auth check, REST polling, review handling, commit identity, deploy verification
- [Owner rulings](owner-rulings.md) - standing decisions on scope, forks, root causes, consults, subagent tiers, and chart labels
- [T3 Code forensics](t3-code-forensics.md) - where a T3 Code thread keeps its Claude session logs and state, and how to correlate them with the tokenmaxxing log
