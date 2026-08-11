---
name: doctor-diagnostics
description: Diagnose a broken or incomplete tokenmaxxing install (supervisor, hooks, timer, credential identity). Use when doctor fails, PATH looks wrong, or identity drift is suspected. Prefer the MCP doctor tool.
---

# Doctor and diagnostics

## Prefer MCP

Call `doctor`. It checks the supervisor wrapper, settings hooks, periodic timer, live/parked credential presence, and org identity match. Output is pass/fail plus labels.

Also useful: `config_get` (no key) for effective config sources, and `pool_ls` for needs-reauth.

## Hard stops

- Never dump keychain items, `.credentials.json`, `auth.json`, or OAuth tokens into chat.
- Doctor never refreshes tokens. Expired access tokens show as unverifiable identity, not as a prompt to paste secrets.
- Do not run `init` / `add` / `auth` from an agent session without the user present for interactive login.

## Common repairs (ask before mutating)

- Missing wrapper or hooks: user runs `tokenmaxxing init` (or `init --codex`).
- needs-reauth: user runs `tokenmaxxing auth <label>` (or `--all`).
- PATH: `binDir` must precede the real claude.

See [references/troubleshooting.md](references/troubleshooting.md).
