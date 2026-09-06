---
name: pool-status
description: Read the Claude and Codex account pool safely (list, usage bars, watch). Use when checking quota, which account is active, needs-reauth, or before any switch. Prefer MCP pool_ls and pool_status over raw shell.
---

# Pool status (safe reads)

## Prefer MCP

- `pool_ls` for labels, active marker, needs-reauth
- `pool_status` for 5h / weekly / per-model bars (free `/usage` path)

If MCP is unavailable, run `tokenmaxxing ls --json` or `tokenmaxxing status --json` (alias `xx`) and parse the document. Never add `--ping`.

## Hard stops

- Do not run `status --ping` or bare `xx --ping`. That pings every account with a real request and opens each 5h window.
- Do not print credential files, keychain blobs, or OAuth tokens. Labels and status only.
- Do not kill sessions or supervisors to "free" an account.

## Notes

- Active Claude usage often comes from the statusLine tee; parked accounts are probed in isolation.
- `watch` re-renders status on an interval and never pings.
- Hermetic agents: set `TOKENMAXXING_HOME` to a throwaway directory. That isolates state files only: `init`, `uninstall`, and the codex hook install still write settings.json, codex `hooks.json`, the shell rc, and the timer unit under `HOME`, so never run them from an agent.

See [references/commands.md](references/commands.md).
