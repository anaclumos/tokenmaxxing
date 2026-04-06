@~/Developer/configs/AGENTS.md

# This is NOT a project you know

This version has breaking changes -- APIs, conventions, and file structure may all differ from your training data. Read the relevant guides before writing any code. Heed deprecation notices.

## General (Project-Specific)

- Use `bunx agent-browser open example.com` CLI, etc to inspect browsers.

## Code Style (Project-Specific)

- App-owned functions with 2+ meaningful domain arguments must use a single object parameter. Exempt: framework callback contracts (e.g. Hono handlers, Inngest step callbacks), React component props, generated files, and trivial single-arg helpers/factories.

## Frontend (Project-Specific)

- Use Sunghyun Sans (https://github.com/anaclumos/sunghyun-sans)
- Use bun.
- Use env.ts with a single Zod schema for type-safe env vars (no t3-oss/env-core).

## MCPs and Skills (Project-Specific)

- All MCPs should be added to all of .mcp.json, opencode.json, and .codex/config.toml.
- All Skills should be installed with `bunx skills`.
