# tokenmaxxing

**Automatic Claude Code account switching.** Run `claude` exactly as you always do; each session starts on the pooled account with the most headroom per running session, and when that account nears its usage limit, tokenmaxxing resumes the session on a fresher account at a safe turn boundary - same conversation, compacted on the account it leaves and restarted under another account's credential store with a first prompt that asks Claude to continue. Works across many concurrent sessions, which spread over the pool instead of draining one account together. When the whole pool is at its limit, a session pauses with a countdown and auto-resumes at the soonest reset, when that reset falls within `policy.maxWaitMs` (default 1h - a longer wait stays put rather than parking your terminal for hours).

> **Scope:** Claude Code on macOS and Linux, plus OpenAI's Codex CLI as a second switching pool; grok and opencode-go as status-only pools. It pools **subscription** accounts (Pro/Max), not API keys; the opencode-go pool, which holds Zen API keys, is the one exception.

```
$ claude
  ...you work normally; the statusline's ◆ marks this session's account...
  ↻ tokenmaxxing: compacting the conversation on me@example.com before the move...
  ↻ tokenmaxxing: moving to work@acme.com - resuming...
  ⏳ tokenmaxxing: all accounts at their limit. Resuming on work@acme.com when it resets (Ctrl-C to resume now).
```

## Why

Every pooled account owns one Claude Code credential store under `~/.config/tokenmaxxing/stores/`. A thin `claude` supervisor on your PATH picks an account for each session and points `CLAUDE_SECURESTORAGE_CONFIG_DIR` at its store, so sessions on different accounts never share a credential, while sessions on the same account share its store and Claude Code's own refresh keeps them in step. A session moves only by respawn: the supervisor stops it at a committed turn boundary (the transcript is already on disk, nothing is lost) and runs `claude --resume <id>` under another store. tokenmaxxing writes a store once at onboarding and never again; it never copies a credential between stores, because a refresh rotation revokes the previous access token and two copies of one grant break each other. Everything else about `claude` is unchanged - all flags, MCP, hooks, and skills pass through. Print mode and the non-interactive subcommands run without a seat, on whatever login the environment names.

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

`init` verifies and pins the real `claude` binary, opens an isolated `claude` session for your first pooled account (run `/login` there, even if you are already signed in; the login you already have stays for sessions started outside the supervisor), installs the `claude` supervisor and the `xx` entry point, five `settings.json` entries (the tokenmaxxing statusLine, a subagentStatusLine, a Stop hook, a StopFailure hook, a SessionStart hook), and the periodic check timer, and adds the supervisor's bin dir to PATH in your shell rc (idempotent; it must sit ahead of the real `claude` to intercept it). Restart your shell, then add more accounts and go:

```sh
tokenmaxxing add        # logs one in, in isolation, into its own store
claude                  # use claude as always; each session gets its own account
```

## Commands

| command | what it does |
|---|---|
| `tokenmaxxing init` | verify and pin the real `claude`, log the first account in (isolated) + install supervisor, hooks, PATH line, and check timer |
| `tokenmaxxing init --codex` | same for codex: log in the first account (isolated), install codex supervisor + Stop hook |
| `tokenmaxxing init --grok` / `init --opencode-go` | pool the first grok login or opencode-go key, status-only: no supervisor, no switching |
| `tokenmaxxing add [--codex \| --grok \| --opencode-go]` | register an additional account in that pool (isolated login, harvested once into its own store) |
| `tokenmaxxing auth [--codex \| --grok \| --opencode-go] [sel \| --all]` | reauthenticate a pooled account in place: bare lists the pool (emails shown) and asks which; a selector targets one account and tells you the email to sign in with; `--all` walks every account that is flagged or has no usable credential in its store, one by one |
| `tokenmaxxing status [--cached]` | every pool: accounts with 5h / weekly / per-model usage bars, live session counts, exhausted-until-reset; `--cached` renders the stored figures without sampling |
| `tokenmaxxing config` | the config path and the effective values; edit the file in an editor, a bad value fails the next load with the field name |
| `tokenmaxxing check` | fold fresh tees, sample up to three stale accounts, and self-update a Bun global install once a day; the periodic timer runs this every tick |
| `tokenmaxxing doctor` | verify the install: PATH order, `claudeBin`, the five settings entries, the timer, the credential identity of every Codex store and of every Claude store whose access token is still fresh (an expiring Claude token is reported as unverifiable, not as a failure), codex hook trust, setup-token age, and shell aliases that shadow `claude` |
| `tokenmaxxing rename [--codex \| --grok \| --opencode-go] <sel> <label>` / `rm [...] <sel>` | manage a pool (one email can hold both a claude and a codex account); `rm` is refused for an account with a running supervised session |
| `tokenmaxxing uninstall [--yes]` | print the targets, then remove the shims, settings entries, codex Stop hook, check timer, and rc PATH line (accounts/stores kept); refused without `--yes` when `HOME` is the login home |
| `tokenmaxxing setup-token [--print \| rm <label\|uuid>]` | Cursor Cloud only: mint one `claude setup-token` per pooled account (a browser sign-in each) and print the `TOKENMAXXING_TOKENS` secret value; `--print` prints the stored set, `rm` drops one |
| `tokenmaxxing cursor init [dir]` | write the Claude relay subagent and `.cursor/environment.json` into a repo |
| `tokenmaxxing cloud run [--session <id>] [--max-turns <n>] "<prompt>"` | on a Cursor Cloud VM: run `claude -p` on a setup token, rotate to the next token on a usage limit |
| `--json` | machine-readable output: one JSON document on stdout for `status`, `config`, and `check` (`ok` mirrors the exit code, failures add `error`) |

## How switching decides

Each session runs on its own seat. One rule: while the seat is under its bars, nothing happens; once it is at or over a bar, the session moves to the usable account that ranks first. The session bar is `thresholds.session` (90) minus `policy.projectionMargin` (3), so **87%** of the 5-hour window by default, and the weekly bar is **98%**. The bars also screen candidates on any of:

- **Session** (5-hour) or **week (all models)** - the aggregate windows, fed free/push-based by the statusLine into one tee per account.
- **Per-model weekly cap** - the most capable model (Fable) has its own tighter weekly limit that binds *before* the aggregate (per-model caps currently exist only for Sonnet and Fable, and Sonnet's is generous). tokenmaxxing reads it from `claude -p '/usage'` under the seat's store (free, 0 tokens, one attempt per interval) whenever the seat's tee is older than `policy.usagePollTtlMs` or the active model is one of `policy.switchModels`, backing off after silent probes, so a Fable session moves on the Fable cap while a Sonnet session rides the aggregate.

The bars' headroom is deliberate: it's the budget to reach a clean turn boundary before the account's real limit. The session bar sits lower (90, minus the margin) because a 5-hour reset is cheap to sit out; weekly quota is use-it-or-lose-it, so it drains closer to the limit (98).

Launches and moves rank usable accounts by session-window headroom per running session, `(bar - used) / (sessions + 1)`, so two fresh accounts alternate and a third session goes to whichever has more headroom left per session; ties break by pace pressure (remaining percent of the binding gated per-model cap, or of the weekly aggregate for an account with no gated row, divided by time to its reset, highest first), then soonest weekly reset, then lowest weekly use. Organization membership is not an input.

- Every periodic check tick folds fresh statusline tees into the index and samples up to three accounts whose last `/usage` attempt is oldest, skipping any attempted within `policy.usagePollTtlMs`: an idle account with a fresh token through the direct no-spend usage read, the rest through `claude -p '/usage'` under the account's store; a move reads the cached figures, which are as fresh as each account's last successful attempt or its sessions' latest push.
- When no account is usable, the session pauses until the soonest reset if that lands within `policy.maxWaitMs`, and otherwise stays put.

See [How switching decides](docs/content/docs/switching.mdx) for the policy and the [cache-cost profile](docs/content/docs/switching-profile.mdx) for measurements and their limits.

## Configuration

`~/.config/tokenmaxxing/config.json` (every field optional):

```json
{
  "thresholds": { "session": 90, "weekly": 98 },
  "policy": {
    "projectionMargin": 3,
    "switchModels": ["fable"],
    "usagePollTtlMs": 90000,
    "maxWaitMs": 3600000,
    "checkIntervalMs": 60000
  }
}
```

`thresholds.session` and `thresholds.weekly` are the two bars, one number each (an array `thresholds.session`, the former ladder, fails config loading with a message naming the field); `projectionMargin` is a fixed safety margin subtracted from the session bar only (default 3), so a large turn is less likely to blow past the 5-hour bar between checks; the weekly bar takes no margin because one turn cannot overshoot a week; `switchModels` names the models whose per-model cap triggers a move; `usagePollTtlMs` is how long a `/usage` attempt stays fresh, for a seat's probe and for the accounts each check tick samples; `maxWaitMs` bounds the depleted-pool countdown - a soonest reset further out than this does not pause the session (no respawn marker is written and the session simply keeps hitting its limit until an account recovers); `checkIntervalMs` is the periodic check tick (default 60s), which `init` writes into the timer - re-run `tokenmaxxing init` after changing it so the timer unit picks up the new tick. `claudeBin`, `codexBin`, `grokBin`, and `opencodeBin` pin the real binaries; `init` writes them, and `TOKENMAXXING_CLAUDE_BIN`, `TOKENMAXXING_CODEX_BIN`, `TOKENMAXXING_GROK_BIN`, and `TOKENMAXXING_OPENCODE_BIN` override them for one process, except that `init` pins the binary it resolved into `config.json`.

State lives in `~/.config/tokenmaxxing/`; outside it the install touches Claude Code's `settings.json`, codex's `hooks.json`, the timer unit, and your shell rc. Each account's credential store is `stores/<uuid8>/`, which Claude Code reads and refreshes as its own: on macOS the credential is a login-keychain item keyed by the store path (never plaintext on disk), on Linux a 0600 `.credentials.json` inside the store (the same plaintext model claude itself uses for `~/.claude/.credentials.json`).

## Codex support

The same pooling works for OpenAI's Codex CLI (your own ChatGPT-subscription accounts):

```sh
tokenmaxxing init --codex   # log in the first account, isolated + install the codex supervisor & Stop hook
tokenmaxxing add --codex    # log in another account, isolated - your primary login is untouched
codex                       # use codex as always
```

Codex mechanics differ from Claude Code in one hard way: a running codex process refuses a credential swapped to a different account, so **a restart is the switch**. Each codex session runs on its own account's store (`codex-stores/<uuid8>/`, only `auth.json` per account, everything else shared with `~/.codex` so resume works across stores). The installed Stop hook runs the same pace-pressure decision at each turn boundary (usage read free from codex's own rate-limit endpoint: percentages plus absolute reset times, the weekly aggregate and every named additional limit alike); when it moves, the supervisor relaunches `codex resume <session-id>` under the target's store with the transcript intact, after compacting the thread on the old account. `status` (and `status --cached`) shows every pool.

Two codex-specific facts worth knowing: codex does not run hooks it has not been told to trust, so after `init --codex` you must open codex once and trust the tokenmaxxing Stop hook via `/hooks` (auto-switching is inert until then); and each codex session runs on its own store, so no live `auth.json` is ever shared: tokenmaxxing refreshes a parked account's token only when it reads usage for it, never one a session is running on, and a move is a restart at an idle turn boundary. `init --codex` refuses a `~/.codex/config.toml` that pins `cli_auth_credentials_store` away from `file`.

## Cursor Cloud

A Cursor Cloud Agent can hand substantial work to Claude Code running on your own accounts. The VM has no keychain and no supervisor, so this path uses setup tokens instead. `tokenmaxxing setup-token` mints one `claude setup-token` per pooled account on your machine and prints the value for a user-scoped Runtime Secret named `TOKENMAXXING_TOKENS`; `tokenmaxxing cursor init` writes a `claude` project subagent and an `environment.json` install line into the repo; on the VM, the subagent forwards each task to `tokenmaxxing cloud run`, which runs `claude -p` on one token per thread and moves the thread to the next token when a run ends on a usage limit. Setup tokens are inference-only and report no usage percentages, so cloud rotation is reactive and the local switching engine never reads one. Details and limits in [Cursor Cloud](docs/content/docs/cursor-cloud.mdx).

## Honest limitations

- **A move restarts the process.** The session resumes the same transcript under the new account and continues on its own from a first prompt the supervisor submits, but the process restarts; a bar-triggered move compacts the conversation on the old account first, so the first turn on the new account uploads the summary, while a move after a refusal re-uploads the full context once (prompt cache is org-scoped).
- **Depleted-pause hiccup.** When the whole pool is at its limit, `claude` stops for the countdown; anything typed in that split second is lost.
- **Unsupervised sessions are not moved.** A claude started outside the supervisor runs on Claude Code's own login, which tokenmaxxing never writes; when a hard limit lands there, the StopFailure hook prints the shim command that resumes the session under the supervisor.
- **One shared identity file.** `~/.claude.json` holds one `oauthAccount` that Claude Code rewrites after whichever session refreshed last, so `/status` can show another session's email; the statusline's `◆` marks the account a session actually uses.
- **Keychain (macOS).** The first keychain access for a new store happens inside the interactive `init`, `add`, or `auth` run, where a prompt can be answered, not inside a headless hook.
- **Plaintext credentials (Linux).** Claude Code itself stores Linux credentials as a 0600 plaintext file; a store follows the same model.
- **Status-only pools carry no usage.** grok and opencode-go accounts render with no bars and never move.

## How it's built

TypeScript on Bun. One multi-call entry (`src/main.ts`) runs the CLI, the `claude` and `codex` supervisors, and the hook/statusLine shims. [Zod](https://zod.dev) validates every external-boundary payload (credential blobs, hook/statusLine stdin, identity responses, config). [es-toolkit](https://es-toolkit.dev) for utilities and [ky](https://github.com/sindresorhus/ky) for the few HTTP calls (the identity check, the no-spend usage read, codex's usage and refresh, the npm version read). The supervisor is process/terminal-only. It never proxies API traffic or touches tokens in flight. Cross-process coordination uses `flock(2)` via `bun:ffi` (macOS has no `flock(1)`; one codepath for both platforms). Credential I/O goes through one platform-selected store: `security(1)` generic-passwords on macOS, atomic 0600 file writes on Linux.

## License

MIT
