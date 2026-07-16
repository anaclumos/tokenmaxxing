# tokenmaxxing

**Automatic Claude Code account switching.** Run `claude` exactly as you always do; when the active account crosses its usage limit, tokenmaxxing swaps to a fresh account and - at the next safe turn boundary - restarts your session *resumed on it*, automatically. Works across many concurrent sessions.

> **Scope:** Claude Code only, macOS and Linux. It pools **subscription** accounts (Pro/Max), not API keys.

```
$ claude
  ...you work normally...
  ↻ tokenmaxxing: switched to work@acme.com - resuming...
  ...same conversation, fresh quota...
```

## Why

A running `claude` re-checks the credential store between requests, so a swapped credential is adopted in-place (within ~30s on macOS, the next request on Linux). tokenmaxxing performs the swap at a committed turn boundary and **respawns** `claude --resume <id>` (the transcript is already on disk, so nothing is lost) - the respawn is what gives you a clean cutover and, when the whole pool is depleted, a countdown that auto-resumes at the soonest reset. A thin `claude` supervisor on your PATH owns that respawn; everything else about `claude` is unchanged - all flags, MCP, hooks, and skills pass through.

## Install

Requires [Bun](https://bun.sh) and Claude Code, on macOS or Linux.

```sh
bun add -g tokenmaxxing
tokenmaxxing init
```

`init` imports the account you're already on, installs the `claude` supervisor + three `settings.json` entries (the tokenmaxxing statusLine, a Stop hook, a SessionStart hook), and adds the supervisor's bin dir to PATH in your shell rc (idempotent; it must sit ahead of the real `claude` to intercept it). Restart your shell, then add more accounts and go:

```sh
tokenmaxxing add        # logs one in, in isolation, and pools it
claude                  # use claude as always
```

## Commands

| command | what it does |
|---|---|
| `tokenmaxxing init` | import the current account + install supervisor & hooks |
| `tokenmaxxing add` | register an additional account (isolated login, harvested into the pool) |
| `tokenmaxxing ls` | list pooled accounts |
| `tokenmaxxing status` | accounts with 5h / weekly usage bars, active + exhausted-until-reset |
| `tokenmaxxing status --force` | additionally ping every account (one tiny haiku request each) so all 5h session timers start now, then sample fresh |
| `tokenmaxxing doctor` | verify the supervisor + settings entries survived |
| `tokenmaxxing rename <sel> <label>` · `rm <sel>` | manage the pool |
| `tokenmaxxing uninstall` | remove supervisor + settings entries (accounts/credentials kept) |

## How switching decides

Switching engages (configurable) once the active account's 5-hour session window is **50% used** - from there, every evaluation greedily converges on the usable account **furthest behind its own weekly pace**, and does nothing when the current account already wins. Independent of that, crossing a hard screening bar - **95%** session or **98%** weekly - always forces a switch. The bars also screen candidates on any of:

- **Session** (5-hour) or **week (all models)** - the aggregate windows, fed free/push-based by the statusLine.
- **Per-model weekly cap** - the most capable model (Fable) has its own tighter weekly limit that binds *before* the aggregate (per-model caps currently exist only for Sonnet and Fable, and Sonnet's is generous). tokenmaxxing reads it from `claude -p '/usage'` (free, 0 tokens, TTL-cached) whenever the active model is one of `policy.switchModels`, so a Fable session switches on the Fable cap while a Sonnet session rides the aggregate.

The bars' headroom is deliberate: it's the budget to reach a clean turn boundary and respawn before the wall. The session bar sits lower (95) because a 5-hour reset is cheap to sit out; weekly quota is use-it-or-lose-it, so it drains closer to the wall (98). The greedy engagement floor sits far below both: weekly allowance is forfeited at each account's fixed reset, so once half a session window justifies the swap, quota is best burned on whichever account has the most at risk.

The **target** is chosen greedily off each account's cached windows: among usable accounts (every window under its bar, or past its reset), the one **furthest behind its own weekly pace** - highest remaining% divided by time to its weekly reset - because unused weekly allowance is forfeited at the fixed per-account reset. Cached resets are absolute UTC epochs, so a stale snapshot still resolves correctly: a weekly reset that has passed extrapolates forward in 7-day steps, and a session window past its reset counts as empty. Both `tokenmaxxing switch` and the automatic path rank the current account too and do nothing when it already wins, so they are idempotent - evaluating periodically converges on the right account.

## Configuration

`~/.config/tokenmaxxing/config.json` (every field optional):

```json
{
  "thresholds": { "session": 95, "weekly": 98 },
  "policy": {
    "projectionMargin": 0,
    "greedySessionFloor": 50,
    "switchModels": ["fable"],
    "usagePollTtlMs": 90000
  }
}
```

`projectionMargin` subtracts an EMA of per-turn Δ% for pre-emption; `greedySessionFloor` is the session-used % at which the greedy convergence engages; `switchModels` names the models whose per-model cap triggers a switch; `usagePollTtlMs` is how long a `/usage` per-model poll stays fresh.

State lives entirely in `~/.config/tokenmaxxing/`. Per-account credentials follow the platform's Claude Code store: the login keychain on macOS (`tokenmaxxing-cred-<uuid8>` items, never plaintext on disk), 0600 files under `~/.config/tokenmaxxing/creds/` on Linux (the same plaintext model claude itself uses for `~/.claude/.credentials.json`).

## Honest limitations

- **One cold turn.** The first turn after resuming on a new account re-uploads context once (prompt cache is org-scoped).
- **Respawn hiccup.** At the swap you see `claude` restart (~1–2s); anything typed in that split second is lost.
- **Shared blast radius.** All default-profile sessions share one live credential, so a swap moves them all together (each respawns its own session). A `flock` + re-check keeps racing hooks from burning two accounts.
- **Keychain ACL (macOS).** `init`/`add` touch the keychain interactively so the first `security` access isn't cold inside a headless hook.
- **Plaintext credentials (Linux).** Claude Code itself stores Linux credentials as a 0600 plaintext file; tokenmaxxing's parked copies follow the same model.

## How it's built

TypeScript on Bun: one multi-call entry (`src/main.ts`) serves the CLI, the `claude` supervisor, and the hook/statusLine shims, and runs directly under bun. [Zod](https://zod.dev) validates every external-boundary payload (credential blobs, hook/statusLine stdin, OAuth responses, config), [es-toolkit](https://es-toolkit.dev) for utilities. The supervisor is process/terminal-only - it never proxies API traffic or touches tokens in flight. Cross-process coordination uses `flock(2)` via `bun:ffi` (macOS has no `flock(1)`; one codepath serves both platforms). Credential I/O goes through one platform-selected store: `security(1)` generic-passwords on macOS, atomic 0600 file writes on Linux.

## License

MIT
