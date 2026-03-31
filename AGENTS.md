# This is NOT a project you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guides before writing any code. Heed deprecation notices.

## General

- If the developer become mad, write down what mistake you made to this doc, in similar bullet style.
- Never suggest or run prod actions unless the user clearly authorizes prod.
- Be humble.
  - You will not know everything
  - Your knowledge cutoff is far in the past.
  - Always search the web whenever possible.
  - You have an infinite search, grep, context7 quota. Always search.
- Never use em-dash.
- Use CLI to install stuff so that you get the latest versions.
- NEVER run `git checkout HEAD --` or `git restore` on directories outside your task scope.
- NEVER use `rm -rf`. Use `trash`.
- Never assume API response formats from third-party examples. Always call the actual API first to verify field names and units before writing code.
- Prefer configured MCP tools over generic web search when they fit the task.
  - Use both `websearch` and `search-mcp` or `parallel-cli search` for web discovery.
  - Use `context7` or `bunx ctx7` cli for library and framework docs.
  - Use `grep` for code examples and `cloudflare` / `pscale` MCPs for their respective platforms when applicable.
  - Use `bunx agent-browser open example.com` CLI, etc to inspect browsers.
  - Use TanStack CLI for TanStack's libraries.
- DO NOT try to generate complex/chained bash/zsh commands. You will make mistakes and cause unintended side effects.
  - Commands should be atomic, small, and isolated.
  - Most importantly, commands should be easy to understand.

## Code Style

- No unnecessary guards, preprocessors, or defensive code. If input is invalid, crash.
- No `typeof` runtime checks or `as` casts for data parsing. Use Zod schemas instead.
- No double-validation. If a library (e.g. Inngest) already validates, don't re-parse.
- No manual error recovery that fights the runtime's retry mechanism (e.g. Inngest retries).
- Use library defaults and built-in types whenever possible. Don't redefine what the library exports.
- Prefer lookup tables over nested ternaries.
- Use tsconfig path aliases (`~/`) for all imports. Relative imports (`./`) only within the same module to avoid circular deps.
- Lean and concise. If a transform, pipe, or helper adds more lines than it saves, inline it.
- App-owned functions with 2+ meaningful domain arguments must use a single object parameter. Exempt: framework callback contracts (e.g. Hono handlers, Inngest step callbacks), React component props, generated files, and trivial single-arg helpers/factories.

## Frontend

- Use Sunghyun Sans (https://github.com/anaclumos/sunghyun-sans)
- Use bun.
- Use env.ts with a single Zod schema for type-safe env vars (no t3-oss/env-core).
- Very selectively use cards. NEVER nest cards.
- Never use vh, h-screen, etc. Use h-full with flex-1. Never use vw either.
- Never use arbitrary Tailwind values (ones with brackets). Always use Tailwind default values.
- Use es-toolkit for most lodash functions.
- Use ky for fetching.
- Better crashing than ducktaping `??` or `null`s.
  - Use latest Zod patterns for child access, instead of chaining.

## MCPs and Skills

- You are encouraged to use MCPs and Skills whenever makes sense.
- If you want new MCPs or Skills, ask first.
  - All MCPs and Skills must be installed under this project; nothing should be installed globally.
- All MCPs should be added to all of .mcp.json, opencode.json, and .codex/config.toml.
- All Skills should be installed with `bunx skills`.

## Secrets

- NEVER read or edit .env directly!
- Do not read them directly.
- If you need to access them, either source the env and pass it as argument, or use cli to get the value.
