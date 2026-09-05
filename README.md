# tokenmaxxing

**Automatic Claude Code account switching.** Run `claude` exactly as you always do; when the active account nears its usage limit, tokenmaxxing swaps the credential to a fresher account at a safe turn boundary and your session keeps running on it - no restart, same conversation. Works across many concurrent sessions. Only when the whole pool is at its limit does anything visible happen: a countdown that auto-resumes at the soonest reset, when that reset falls within `policy.maxWaitMs` (default 1h - a longer wait stays put rather than parking your terminal for hours).

> **Scope:** Claude Code only, macOS and Linux. It pools **subscription** accounts (Pro/Max), not API keys.

```
$ claude
  ...you work normally; swaps are invisible (watch the statusline account flip)...
  ⏳ tokenmaxxing: all accounts at their limit. Resuming on work@acme.com when it resets (Ctrl-C to resume now).
```

## Why

A running `claude` re-checks the credential store between requests, so a swapped credential is adopted in-place (within ~30s on macOS, the next request on Linux) - a swap never restarts your session. The one case that still needs process management is a fully depleted pool: a session cannot pause itself, so a thin `claude` supervisor on your PATH stops it at a committed turn boundary (the transcript is already on disk, nothing is lost), shows a countdown, and auto-resumes `claude --resume <id>` at the soonest reset. Everything else about `claude` is unchanged - all flags, MCP, hooks, and skills pass through.

## Install

Requires [Bun](https://bun.sh) and Claude Code, on macOS or Linux.

```sh
bun add -g tokenmaxxing
tokenmaxxing init
```

Or with Nix (same source-run-by-Bun package; `init` still owns credentials, the `claude` shim, and settings merges). Install onto PATH first, then init — `nix run ... -- init` alone leaves supervisor shims without a stable `tokenmaxxing` on PATH after the ephemeral run exits:

```sh
nix profile install github:anaclumos/tokenmaxxing
tokenmaxxing init
```

nix-darwin:

```nix
inputs.tokenmaxxing.url = "github:anaclumos/tokenmaxxing";
modules = [
  inputs.tokenmaxxing.darwinModules.withOverlay
  { programs.tokenmaxxing.enable = true; }
];
```

Home Manager:

```nix
imports = [ inputs.tokenmaxxing.homeManagerModules.default ];
programs.tokenmaxxing.enable = true;
programs.tokenmaxxing.package = inputs.tokenmaxxing.packages.${pkgs.system}.default;
```

With either module, run `tokenmaxxing init` afterwards.

`init` imports the account you're already on, installs the `claude` supervisor + five `settings.json` entries (the tokenmaxxing statusLine, a subagentStatusLine, a Stop hook, a StopFailure hook, a SessionStart hook), and adds the supervisor's bin dir to PATH in your shell rc (idempotent; it must sit ahead of the real `claude` to intercept it). Restart your shell, then add more accounts and go:

```sh
tokenmaxxing add        # logs one in, in isolation, and pools it
claude                  # use claude as always
```

## Commands

| command | what it does |
|---|---|
| `tokenmaxxing init` | import the current account + install supervisor & hooks |
| `tokenmaxxing init --codex` | same for codex: import login, install codex supervisor + Stop hook |
| `tokenmaxxing add` | register an additional account (isolated login, harvested into the pool) |
| `tokenmaxxing add --codex` | register an additional codex account (isolated login) |
| `tokenmaxxing auth [sel \| --all]` | reauthenticate a pooled account in place: bare lists the pool (emails shown) and asks which; a selector targets one account and tells you the email to sign in with; `--all` walks every needs-reauth account one by one |
| `tokenmaxxing switch [sel]` | switch the claude pool: bare picks the best account greedily (no-op when the current one wins), a selector targets one |
| `tokenmaxxing switch --codex [sel]` | switch the codex pool (takes effect on the next codex start) |
| `tokenmaxxing ls` | list pooled accounts |
| `tokenmaxxing status` | accounts with 5h / weekly usage bars, active + exhausted-until-reset |
| `tokenmaxxing status --force` | additionally ping every account (one tiny haiku request each) so all 5h session timers start now, then sample fresh |
| `tokenmaxxing watch [seconds]` | live status: re-render every N seconds (default 120, floor 30; never pings) |
| `tokenmaxxing config` | effective config with sources; `get`/`set`/`unset` dotted keys, `tidy` prunes unknown keys |
| `tokenmaxxing doctor` | verify the supervisor + settings entries survived |
| `tokenmaxxing rename [--codex] <sel> <label>` / `rm [--codex] <sel>` | manage the pool (`--codex` targets the codex pool: one email can hold both a claude and a codex account) |
| `tokenmaxxing uninstall` | remove supervisor + settings entries (accounts/credentials kept) |
| `--json` | machine-readable output: one JSON document on stdout for `status`, `ls`, `config`, `doctor`, `check`, `switch`, `rename`, `rm`, `uninstall`, and one per tick for `watch` (`ok` mirrors the exit code, failures add `error`) |

## How switching decides

Switching engages (configurable) once the active account's 5-hour session window is **80% used** - from there, every evaluation greedily converges on the usable account **furthest behind its own weekly pace**, and does nothing when the current account already wins. Independent of that, crossing a screening bar always forces a switch: the session bar is the active rung of a ladder (a single rung at **90** by default; with more rungs configured, each takes over once every pooled account is past the one below) and the weekly bar is **98%**. The bars also screen candidates on any of:

- **Session** (5-hour) or **week (all models)** - the aggregate windows, fed free/push-based by the statusLine.
- **Per-model weekly cap** - the most capable model (Fable) has its own tighter weekly limit that binds *before* the aggregate (per-model caps currently exist only for Sonnet and Fable, and Sonnet's is generous). tokenmaxxing reads it from `claude -p '/usage'` (free, 0 tokens, TTL-cached) whenever the active model is one of `policy.switchModels`, so a Fable session switches on the Fable cap while a Sonnet session rides the aggregate.

The bars' headroom is deliberate: it's the budget to reach a clean turn boundary (plus up to one turn of adoption lag on macOS) before the wall. The session ladder tops out lower (90) because a 5-hour reset is cheap to sit out, and any lower rungs you add keep the pool draining level by level; weekly quota is use-it-or-lose-it, so it drains closer to the wall (98). The greedy engagement floor (80) sits below both: weekly allowance is forfeited at each account's fixed reset, so once most of a session window is spent, quota is best burned on whichever account has the most at risk.

The **target** is chosen greedily off each account's cached windows: among usable accounts (every window under its bar, or past its reset), the one **furthest behind its own weekly pace** - highest remaining% divided by time to its weekly reset - because unused weekly allowance is forfeited at the fixed per-account reset. Cached resets are absolute UTC epochs, so a stale snapshot still resolves correctly: a weekly reset that has passed extrapolates forward in 7-day steps, and a session window past its reset counts as empty. Both `tokenmaxxing switch` and the automatic path rank the current account too and do nothing when it already wins, so they are idempotent - evaluating periodically converges on the right account.

## Configuration

`~/.config/tokenmaxxing/config.json` (every field optional):

```json
{
  "thresholds": { "session": [90], "weekly": 98 },
  "policy": {
    "projectionMargin": 0,
    "greedySessionFloor": 80,
    "switchModels": ["fable"],
    "usagePollTtlMs": 90000
  }
}
```

`thresholds.session` is a ladder: the bar is the lowest rung some pooled account still clears, so the default `[90]` is one bar, while with `[50, 80, 95]` a seat past 50 hands off while a sibling is under 50, and the bar climbs to 80 and then 95 as the whole pool fills; `projectionMargin` is a fixed safety margin subtracted from each threshold bar (effective bar = threshold - margin), so a large turn is less likely to blow past a bar between checks; `greedySessionFloor` is the session-used % at which the greedy convergence engages; `switchModels` names the models whose per-model cap triggers a switch; `usagePollTtlMs` is how long a `/usage` per-model poll stays fresh; `maxWaitMs` bounds the depleted-pool countdown - a soonest reset further out than this does not pause the session (no respawn marker is written and the session simply keeps hitting its limit until an account recovers).

State lives entirely in `~/.config/tokenmaxxing/`. Per-account credentials follow the platform's Claude Code store: the login keychain on macOS (`tokenmaxxing-cred-<uuid8>` items, never plaintext on disk), 0600 files under `~/.config/tokenmaxxing/creds/` on Linux (the same plaintext model claude itself uses for `~/.claude/.credentials.json`).

## Pairing with the Claude Agent SDK

For agents you build on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) against **your own** pooled accounts, `tokenmaxxing` is importable as a library (your agent app must run under Bun: tokenmaxxing ships TypeScript source and uses `bun:ffi`):

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ensureBestAccount, pooledOptions, stopHookCheck } from "tokenmaxxing";

await ensureBestAccount();

for await (const message of query({
  prompt: "...",
  options: {
    ...pooledOptions(),
    hooks: { Stop: [{ hooks: [stopHookCheck] }] },
  },
})) {
}
```

The loop body receives the message stream; keep the session id from the init message if you want `resume` across swaps.

The SDK reads credentials when it spawns the claude subprocess and has no statusLine, so none of the CLI-side supervisor machinery applies; the integration is boundary-driven instead. `ensureBestAccount()` runs the exact greedy decision the CLI hooks and timer run (screening bars, pace-pressure target, post-swap cooldown - all shared code); like them, it deliberately does nothing until the decision engages (the active session past `policy.greedySessionFloor`, or a bar crossed), so a fresh account rides instead of churning. `pooledOptions()` pins `pathToClaudeCodeExecutable` to the real claude binary and supplies a full replacement `env` with every ambient credential override (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, ...) scrubbed, so the subprocess resolves the pool's live credential and nothing else. The pooled surface requires the default Claude Code credential store: it fails fast if `CLAUDE_CONFIG_DIR` or `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set in your app's environment, because a swap would write the live credential where those point while the spawned subprocess reads the default store. `stopHookCheck` re-runs the decision at turn boundaries; a swap it lands takes effect on the next subprocess spawn (it never yanks a mid-query token). If your app loads user settings (see the SDK's `settingSources`), the Stop hook `tokenmaxxing init` installed may already fire in SDK sessions too - `stopHookCheck` makes the check explicit and works when settings are restricted.

This is for pooling **your own** subscription accounts in agents you run yourself - the same personal-use posture as the CLI. Anthropic does not allow third-party products to offer claude.ai login or rate limits, including agents built on the Agent SDK; don't ship this surface to third parties.

## Codex support

The same pooling works for OpenAI's Codex CLI (your own ChatGPT-subscription accounts):

```sh
tokenmaxxing init --codex   # import your current codex login + install the codex supervisor & Stop hook
tokenmaxxing add --codex    # log in another account, isolated - your primary login is untouched
codex                       # use codex as always
```

Codex mechanics differ from Claude Code in one hard way: a running codex process refuses a credential swapped to a different account, so **a restart is the switch**. The installed Stop hook runs the same greedy pace-pressure decision at each turn boundary (usage read free from codex's own rate-limit endpoint: percentages plus absolute reset times, weekly aggregate and per-model caps alike); when it swaps, the supervisor relaunches `codex resume <session-id>` on the fresh account with the transcript intact. `tokenmaxxing switch --codex [sel]` does it manually, `status`/`watch`/`ls` show both pools.

Two codex-specific facts worth knowing: codex does not run hooks it has not been told to trust, so after `init --codex` you must open codex once and trust the tokenmaxxing Stop hook via `/hooks` (auto-switching is inert until then); and codex has no cross-process lock on `auth.json`, so tokenmaxxing serializes all of its own credential writes behind its own lock and swaps only at idle turn boundaries.

## Honest limitations

- **One cold turn.** The first turn on a new account re-uploads context once (prompt cache is org-scoped).
- **Depleted-pause hiccup.** Plain swaps never restart the session. Only when the whole pool is at its limit does `claude` stop for the countdown; anything typed in that split second is lost.
- **Adoption lag.** On macOS the first turn within ~30s of a swap can still meter the old account; the bars' headroom absorbs it.
- **Shared blast radius.** All default-profile sessions share one live credential, so a swap moves them all together (each adopts in place). A `flock` + re-check keeps racing hooks from burning two accounts.
- **Keychain ACL (macOS).** `init`/`add` touch the keychain interactively so the first `security` access isn't cold inside a headless hook.
- **Plaintext credentials (Linux).** Claude Code itself stores Linux credentials as a 0600 plaintext file; tokenmaxxing's parked copies follow the same model.

## How it's built

TypeScript on Bun. One multi-call entry (`src/main.ts`) runs the CLI, the `claude` supervisor, and the hook/statusLine shims. [Zod](https://zod.dev) validates every external-boundary payload (credential blobs, hook/statusLine stdin, OAuth responses, config). [es-toolkit](https://es-toolkit.dev) for utilities. The supervisor is process/terminal-only. It never proxies API traffic or touches tokens in flight. Cross-process coordination uses `flock(2)` via `bun:ffi` (macOS has no `flock(1)`; one codepath for both platforms). Credential I/O goes through one platform-selected store: `security(1)` generic-passwords on macOS, atomic 0600 file writes on Linux.

## License

MIT
