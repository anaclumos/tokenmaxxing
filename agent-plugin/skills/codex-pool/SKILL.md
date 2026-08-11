---
name: codex-pool
description: Operate the Codex side of the pool (restart-is-switch, no Layer 2, never target a running sibling). Use for codex init/switch/status questions or MCP pool_switch with codex=true.
---

# Codex pool

## Mechanics

- No hot-swap: restart IS the switch (`codex resume <sid>`). A credential write takes effect on the next codex start.
- Auto-switching needs trusted hooks (`/hooks`). Do not clobber the user's `notify` key in `config.toml`.
- Refresh-token reuse is punished; a superseded token can kill the grant family. Persist every rotation immediately.
- An account running in another supervised session is never a swap target and never sampler-refreshed. Parked does not mean idle.
- Classify windows by DURATION, never by position. Some plans have no 5h window.
- Layer 2 wall squeeze is Claude-only. Do not extend it to Codex.

## Agent actions

- Read: `pool_ls` / `pool_status` (Codex section included when present).
- Mutate: MCP `pool_switch` with `codex=true`, `confirm=true`, and `TOKENMAXXING_AGENT_MUTATIONS=1` after user approval.
- Interactive `init --codex` / `add --codex` / reauth stay human-driven.

See [references/codex.md](references/codex.md).
