# tokenmaxxing

**Automatic Claude Code account switching.** Run `claude` exactly as you always do; each session starts on the pooled account with the most headroom per running session, and when that account nears its usage limit, tokenmaxxing resumes the session on a fresher account at a safe turn boundary - same conversation, restarted under another account's credential store. Works across many concurrent sessions, which spread over the pool instead of draining one account together. When the whole pool is at its limit, a session pauses with a countdown and auto-resumes at the soonest reset, when that reset falls within `policy.maxWaitMs` (default 1h - a longer wait stays put rather than parking your terminal for hours).

> **Scope:** Claude Code only, macOS and Linux. It pools **subscription** accounts (Pro/Max), not API keys.

```
$ claude
  ...you work normally; the statusline's ◆ marks this session's account...
  ↻ tokenmaxxing: moving to work@acme.com - resuming...
  ⏳ tokenmaxxing: all accounts at their limit. Resuming on work@acme.com when it resets (Ctrl-C to resume now).
```

## Why

Every pooled account owns one Claude Code credential store under `~/.config/tokenmaxxing/stores/`. A thin `claude` supervisor on your PATH picks an account for each session and points `CLAUDE_SECURESTORAGE_CONFIG_DIR` at its store, so sessions on different accounts never share a credential, while sessions on the same account share its store and Claude Code's own refresh keeps them in step. A session moves only by respawn: the supervisor stops it at a committed turn boundary (the transcript is already on disk, nothing is lost) and runs `claude --resume <id>` under another store. tokenmaxxing writes a store once at onboarding and never again; it never copies a credential between stores, because a refresh rotation revokes the previous access token and two copies of one grant break each other. Everything else about `claude` is unchanged - all flags, MCP, hooks, and skills pass through.

## Install

Requires [Bun](https://bun.sh) and Claude Code, on macOS or Linux.

```sh
bun add -g tokenmaxxing
tokenmaxxing init
```

Or with Nix (same source-run-by-Bun package; `init` still owns the stores, the `claude` shim, and settings merges). Install onto PATH first, then init: `nix run ... -- init` alone leaves supervisor shims without a stable `tokenmaxxing` on PATH after the ephemeral run exits.

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

`init` opens a browser sign-in for your first pooled account (even if you are already signed in; the login you already have stays for sessions started outside the supervisor), installs the `claude` supervisor + five `settings.json` entries (the tokenmaxxing statusLine, a subagentStatusLine, a Stop hook, a StopFailure hook, a SessionStart hook), and adds the supervisor's bin dir to PATH in your shell rc (idempotent; it must sit ahead of the real `claude` to intercept it). Restart your shell, then add more accounts and go:

```sh
tokenmaxxing add        # logs one in, in isolation, into its own store
claude                  # use claude as always; each session gets its own account
```

## Commands

| command | what it does |
|---|---|
| `tokenmaxxing init` | log the first account in (isolated) + install supervisor & hooks |
| `tokenmaxxing init --codex` | same for codex: import login, install codex supervisor + Stop hook |
| `tokenmaxxing add` | register an additional account (isolated login, harvested once into its own store) |
| `tokenmaxxing add --codex` | register an additional codex account (isolated login) |
| `tokenmaxxing auth [--codex] [sel \| --all]` | reauthenticate a pooled account in place: bare lists the pool (emails shown) and asks which; a selector targets one account and tells you the email to sign in with; `--all` walks every account that is flagged or has no usable credential in its store, one by one; `--codex` does the same for the codex pool |
| `tokenmaxxing switch --codex [sel]` | switch the codex pool (takes effect on the next codex start); the claude pool has no manual switch, each session is placed at launch |
| `tokenmaxxing status [--cached]` | accounts with 5h / weekly usage bars, live session counts, exhausted-until-reset; `--cached` renders the stored figures without sampling |
| `tokenmaxxing config` | the config path and the effective values; edit the file in an editor, a bad value fails the next load with the field name |
| `tokenmaxxing doctor` | verify the supervisor + settings entries survived and every store holds its account's credential |
| `tokenmaxxing rename [--codex] <sel> <label>` / `rm [--codex] <sel>` | manage the pool (`--codex` targets the codex pool: one email can hold both a claude and a codex account) |
| `tokenmaxxing uninstall` | remove supervisor + settings entries (accounts/stores kept) |
| `tokenmaxxing setup-token [--print \| rm <label\|uuid>]` | Cursor Cloud only: mint one `claude setup-token` per pooled account (a browser sign-in each) and print the `TOKENMAXXING_TOKENS` secret value; `--print` prints the stored set, `rm` drops one |
| `tokenmaxxing cursor init [dir]` | write the Claude relay subagent and `.cursor/environment.json` into a repo |
| `tokenmaxxing cloud run [--session <id>] [--max-turns <n>] "<prompt>"` | on a Cursor Cloud VM: run `claude -p` on a setup token, rotate to the next token on a usage limit |
| `--json` | machine-readable output: one JSON document on stdout for `status`, `config`, `check`, and `switch` (`ok` mirrors the exit code, failures add `error`) |

## How switching decides

Each session runs on its own seat. One rule: while the seat is under its bars, nothing happens; once it is at or over a bar, the session moves to the usable account that ranks first. The session bar is **90%** of the 5-hour window and the weekly bar is **98%**. The bars also screen candidates on any of:

- **Session** (5-hour) or **week (all models)** - the aggregate windows, fed free/push-based by the statusLine into one tee per account.
- **Per-model weekly cap** - the most capable model (Fable) has its own tighter weekly limit that binds *before* the aggregate (per-model caps currently exist only for Sonnet and Fable, and Sonnet's is generous). tokenmaxxing reads it from `claude -p '/usage'` under the seat's store (free, 0 tokens, TTL-cached) whenever the active model is one of `policy.switchModels`, so a Fable session moves on the Fable cap while a Sonnet session rides the aggregate.

The bars' headroom is deliberate: it's the budget to reach a clean turn boundary before the account's real limit. The session bar sits lower (90) because a 5-hour reset is cheap to sit out; weekly quota is use-it-or-lose-it, so it drains closer to the limit (98).

Launches and moves rank usable accounts by session-window headroom per running session, `(bar - used) / (sessions + 1)`, so two fresh accounts alternate and a third session goes to whichever has more headroom left per session; ties break by weekly pace pressure (remaining weekly percent divided by time to reset, highest first). Organization membership is not an input.

- Every periodic check tick folds fresh statusline tees into the index and samples the account whose last `/usage` attempt is oldest, under that account's store, skipping any attempted within `policy.usagePollTtlMs`; a move reads the cached figures, which are as fresh as each account's last successful attempt or its sessions' latest push.
- When no account is usable, the session pauses until the soonest reset if that lands within `policy.maxWaitMs`, and otherwise stays put.

See [How switching decides](docs/content/docs/switching.mdx) for the policy and the [cache-cost profile](docs/content/docs/switching-profile.mdx) for measurements and their limits.

## Configuration

`~/.config/tokenmaxxing/config.json` (every field optional):

```json
{
  "thresholds": { "session": 90, "weekly": 98 },
  "policy": {
    "projectionMargin": 0,
    "switchModels": ["fable"],
    "usagePollTtlMs": 90000,
    "checkIntervalMs": 60000
  }
}
```

`thresholds.session` and `thresholds.weekly` are the two bars, one number each (an array `thresholds.session`, the former ladder, fails config loading with a message naming the field); `projectionMargin` is a fixed safety margin subtracted from each threshold bar (effective bar = threshold - margin), so a large turn is less likely to blow past a bar between checks; `switchModels` names the models whose per-model cap triggers a move; `usagePollTtlMs` is how long a `/usage` attempt stays fresh, for a seat's per-model poll and for the account each check tick samples; `maxWaitMs` bounds the depleted-pool countdown - a soonest reset further out than this does not pause the session (no respawn marker is written and the session simply keeps hitting its limit until an account recovers); `checkIntervalMs` is the periodic check tick (default 60s), which `init` writes into the timer - re-run `tokenmaxxing init` after changing it so the timer unit picks up the new tick.

State lives entirely in `~/.config/tokenmaxxing/`. Each account's credential store is `stores/<uuid8>/`, which Claude Code reads and refreshes as its own: on macOS the credential is a login-keychain item keyed by the store path (never plaintext on disk), on Linux a 0600 `.credentials.json` inside the store (the same plaintext model claude itself uses for `~/.claude/.credentials.json`).

## Codex support

The same pooling works for OpenAI's Codex CLI (your own ChatGPT-subscription accounts):

```sh
tokenmaxxing init --codex   # import your current codex login + install the codex supervisor & Stop hook
tokenmaxxing add --codex    # log in another account, isolated - your primary login is untouched
codex                       # use codex as always
```

Codex mechanics differ from Claude Code in one hard way: a running codex process refuses a credential swapped to a different account, and codex has no per-session credential store, so **a restart is the switch** and every codex session shares one live login. The installed Stop hook runs the same pace-pressure decision at each turn boundary (usage read free from codex's own rate-limit endpoint: percentages plus absolute reset times, weekly aggregate and per-model caps alike); when it swaps, the supervisor relaunches `codex resume <session-id>` on the fresh account with the transcript intact. `tokenmaxxing switch --codex [sel]` does it manually, `status` (and `status --cached`) shows both pools.

Two codex-specific facts worth knowing: codex does not run hooks it has not been told to trust, so after `init --codex` you must open codex once and trust the tokenmaxxing Stop hook via `/hooks` (auto-switching is inert until then); and codex has no cross-process lock on `auth.json`, so tokenmaxxing serializes all of its own credential writes behind its own lock and swaps only at idle turn boundaries.

## Cursor Cloud

A Cursor Cloud Agent can hand substantial work to Claude Code running on your own accounts. The VM has no keychain and no supervisor, so this path uses setup tokens instead. `tokenmaxxing setup-token` mints one `claude setup-token` per pooled account on your machine and prints the value for a user-scoped Runtime Secret named `TOKENMAXXING_TOKENS`; `tokenmaxxing cursor init` writes a `claude` project subagent and an `environment.json` install line into the repo; on the VM, the subagent forwards each task to `tokenmaxxing cloud run`, which runs `claude -p` on one token per thread and moves the thread to the next token when a run ends on a usage limit. Setup tokens are inference-only and report no usage percentages, so cloud rotation is reactive and the local switching engine never reads one. Details and limits in [Cursor Cloud](docs/content/docs/cursor-cloud.mdx).

## Honest limitations

- **A move restarts the process.** The session resumes the same transcript under the new account, but the process restarts and the first turn on the new account re-uploads context once (prompt cache is org-scoped).
- **Depleted-pause hiccup.** When the whole pool is at its limit, `claude` stops for the countdown; anything typed in that split second is lost.
- **Unsupervised sessions are not moved.** A claude started outside the supervisor runs on Claude Code's own login, which tokenmaxxing never writes.
- **One shared identity file.** `~/.claude.json` holds one `oauthAccount` that Claude Code rewrites after whichever session refreshed last, so `/status` can show another session's email; the statusline's `◆` marks the account a session actually uses.
- **Keychain ACL (macOS).** `init`/`add` touch the keychain interactively so the first `security` access isn't cold inside a headless hook.
- **Plaintext credentials (Linux).** Claude Code itself stores Linux credentials as a 0600 plaintext file; a store follows the same model.

## How it's built

TypeScript on Bun. One multi-call entry (`src/main.ts`) runs the CLI, the `claude` supervisor, and the hook/statusLine shims. [Zod](https://zod.dev) validates every external-boundary payload (credential blobs, hook/statusLine stdin, identity responses, config). [es-toolkit](https://es-toolkit.dev) for utilities. The supervisor is process/terminal-only. It never proxies API traffic or touches tokens in flight. Cross-process coordination uses `flock(2)` via `bun:ffi` (macOS has no `flock(1)`; one codepath for both platforms). Credential I/O goes through one platform-selected store: `security(1)` generic-passwords on macOS, atomic 0600 file writes on Linux.

## License

MIT
