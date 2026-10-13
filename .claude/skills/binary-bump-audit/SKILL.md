---
name: binary-bump-audit
description: Audit the tables tokenmaxxing keeps in step with the claude, Claude Agent SDK, and pi binaries. Use when the installed claude or pi version changes, when a respawn drops a flag value, when a claude subcommand runs as a session, or when a model family stops gating.
---

# Binary bump audit

## Claude Code

- `VALUE_TAKING_ROOT_FLAGS` (`src/entries/supervisor.ts`): audit the table against `claude --help` and against the flags the Claude Agent SDK's argument builder pushes (`grep -o 'push("--[a-z-]*",' sdk.mjs` on `$BUN_INSTALL/install/cache/@anthropic-ai/claude-agent-sdk@<version>@@@1/sdk.mjs`, present only when some project installed the SDK; the T3 Code runtime keeps none on disk, so read its binary by the byte-offset recipe in `.memory/claude_code.md`), because `--help` hides the SDK-only ones (`--max-turns`, `--thinking`, `--task-budget`).
- `SUBCOMMANDS` (`src/entries/supervisor.ts`): run `claude <name> --help` for every name in the binary's `.command("<name>"` and `new <Command>("<name>")` calls and keep each one that prints its own usage line, and read the argv checks that run before the command parser.
- `MODEL_FAMILIES` (`src/lib/usage.ts`): keep it equal to the binary's alias families.
- `isCapabilitiesProbe` and `probeUsageLine` (`src/entries/supervisor.ts`): audit the flag and environment sets against T3 Code's capability probe builder (`buildClaudeCapabilitiesProbeQueryOptions` in the T3 Code binary, read by the byte-offset recipe in `.memory/claude_code.md`) mapped through the SDK argument builder above, the forwarded stdin line kinds against the control requests that builder's query sends, and the synthesized `get_usage` response against the binary's response schema for that request. A drifted set fails closed to the unmanaged passthrough, so T3 Code reports Claude unauthenticated instead of spending a pooled account.

## pi

- `VALUE_FLAGS`, `BOOLEAN_FLAGS`, and `UNMANAGED_FLAGS` (`src/entries/pisupervisor.ts`): audit them against pi's `dist/cli/args.js`.
