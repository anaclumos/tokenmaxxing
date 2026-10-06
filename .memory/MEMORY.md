# Memory: tokenmaxxing

- This folder is tracked in a public repository and is the one memory store for every agent that works here: the Claude Code harness memory directory for this project is a symlink to it, and Codex reads `AGENTS.md` directly; every entry meets the public bar (no hostnames, host paths that identify a machine, account labels, personal names, credential layout, or secrets).
- An entry is one guardrail on one line, in present tense with no history or dates: the trap, the correct move, and the exact command, flag, path, or error string; a fact the code, `--help`, `DESIGN.md`, `AGENTS.md`, or `docs/` already shows does not belong here, and a note the code has outgrown is deleted.
- Both CLIs change monthly: re-verify a recorded mechanic in [[claude_code]] or [[codex]] against the installed binary before building on it.

## Index
- [[claude_code]]
- [[codex]]
- [[pi]]
- [[shipping]]
- [[owner_rulings]]
- [[t3_code]]
- [[platform]]
- [[hermetic_runs]]
- [[docs_site]]
- [[pool_state]]
- [[host]]
- [[ci]]
