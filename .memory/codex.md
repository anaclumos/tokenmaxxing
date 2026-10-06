# Codex internals

Verified mechanics of the Codex CLI that the Codex pool depends on. Source-verified against `openai/codex` rust-v0.144.5 and re-checked on the installed 0.145.x through 0.153.x binaries; codex changes monthly, so re-verify an entry before building on it. Claude is in [[claude_code]].

## Store

- Credentials live in `$CODEX_HOME/auth.json` (0600).
- The store mode key is `cli_auth_credentials_store`, a top-level `config.toml` key whose default is `file`; `keyring` and `auto` remap down to `file`, and `cli_auth_credentials_store_mode` is not a key (a write under that name is silently ignored).
- Login isolation is `CODEX_HOME=<dir> codex login`; `--device-auth` is the flow that works over ssh (the browser flow binds localhost), and `--with-access-token` reads a token from stdin.

## No hot swap

- The session `AuthManager` is built once per process and `auth.json` is never re-read for inference; `/new` reuses the manager.
- A near-expiry refresh runs `reload_if_account_id_matches` first and, on a different account, returns a permanent "signed in to another account" error without refreshing, so a session whose store changed underneath it limps on the stale token until a server 401 and then asks the user to sign in again.
- Restart is the switch: `codex resume <sid>` continues the thread on the new store.
- The Apps and connectors surface still touches tokens: on every `SessionConfigured` (including `/new`) and on `/apps` it builds throwaway auth managers that fresh-read the session's own `auth.json` and can refresh and persist a rotation under the in-process semaphore only, outside any tokenmaxxing lock; read the store file at the last moment and persist a rotation the instant it returns.

## Refresh

- The refresh endpoint is `auth.openai.com/oauth/token`, with a five-minute margin plus an eight-day interval and a rotating refresh token; reuse is punished, and a superseded refresh token (`refresh_token_reused`) kills the whole grant family.
- There is no cross-process lock on `auth.json` (re-verified at rust-v0.159.2 in `codex-rs/login/src/auth/manager.rs` and `storage.rs`): a proactive refresh re-reads the file and skips the POST when the record changed, but only an in-process semaphore guards the refresh, the file is truncated and rewritten in place, and the 401 recovery path refreshes without the re-read and ends the turn on `refresh_token_reused`.
- Two processes on one `auth.json` that refresh together POST the same refresh token; codex locks its gateway and MCP OAuth stores across processes, never `auth.json`, so a store that several processes share (`seat --codex` borrowers included) can lose a refresh race, and an account signed out by it needs `tokenmaxxing auth --codex`.

## Usage

- `GET chatgpt.com/backend-api/wham/usage` is free with the stored access token and returns identity (`account_id`, `email`, `plan_type`) plus windows with `used_percent`, `limit_window_seconds`, and `reset_at` in epoch seconds.
- The weekly window is primary on current Plus and Pro plans and a 5h window may be absent, so windows classify by duration, never by position.
- Per-model and reserve caps arrive in `additional_rate_limits[]` keyed by `limit_name` (`GPT-5.3-Codex-Spark`, `gpt-reserve`); derive a label structurally from the wire name and abbreviate afterwards (`spark`, `rsrv`), never match an exact string.
- `rate_limit_reset_credits.available_count` counts banked resets (the body also carries `applicable_available_count`, which the codex source never reads) and `rate_limit_reached_type.type` names the refusal kind.
- A banked reset is consumed with `POST /wham/rate-limit-reset-credits/consume`, body `{"redeem_request_id": <idempotency key>}` plus an optional `credit_id`, under the usage read's headers; the answer is `{"code": "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed", "windows_reset": <count>}`.
- `GET /wham/rate-limit-reset-credits` lists each credit's `id`, `reset_type` (`codex_rate_limits`), `status` (`available`, `redeeming`, `redeemed`), and `expires_at` (`backend-client/src/client/rate_limit_resets.rs`, the strings present in the 0.159.2 binary).
- `credits` reports purchased credits: `has_credits` is the one credit field the codex binary reads (`false` with `balance: "0"` on an account that bought none), `balance` is a string, and `overage_limit_reached` is never read by the binary.
- `rate_limit` also carries `allowed` and `limit_reached` booleans; the body of an account past 100 percent on credits, and of one whose credits ran out, is unverified.
- `codex exec` exits 1 at a limit with a per-`limit_name` message.

## Hooks

- Hooks load from `hooks.json` or `config.toml` `[hooks]` and from a plugin manifest's `hooks` path; a new hook is silently skipped until the user trusts it in `/hooks`.
- The legacy `notify` key still works and belongs to the user.
- Stop stdin carries `session_id`, `turn_id`, `transcript_path`, `stop_hook_active`, and `last_assistant_message`, and no error signal.
- `codex app-server` speaks JSON-RPC over stdio: `thread/resume` then `thread/compact/start` compacts a thread and persists the boundary into the rollout.

## SDK consumers

- The Codex SDK resolves its bundled `codex` from `node_modules` and spawns it with the inherited environment and no `CODEX_HOME`, so nothing on `PATH` (the tokenmaxxing shim included) is in that path and the run lands on the ambient `~/.codex` login; such a consumer borrows a seat with `tokenmaxxing seat --codex <pid>` and passes the printed store as `CODEX_HOME`.
## Runtime, source, and plugin

- `load_auth` picks a credential in this order: `CODEX_API_KEY` (only when the caller sets `enable_codex_api_key_env`, which the TUI does not), a host-supplied in-memory store, `CODEX_ACCESS_TOKEN`, then `$CODEX_HOME/auth.json`, so an inherited `CODEX_ACCESS_TOKEN` outranks the seat's store. It takes only a PAT or an agent JWT, never a ChatGPT OAuth login, so `CODEX_HOME` stays the one isolation point (source read at rust-v0.153.4; re-verify on a binary bump).
- `CODEX_HOME` must name an existing directory (else `NotFound` or `InvalidInput`), gets no tilde expansion, is canonicalized, and has no flag or `config.toml` override, so a store exists (`ensureCodexStoreHome`) before the spawn and the env variable is the only way to point codex at it. `codex resume` finds a thread through the shared `sessions` tree under any home.
- Codex writes `config.toml` edits (hook trust, model, project trust) through `resolve_symlink_write_paths`, then a temp file and a rename onto the resolved target, so a store's `config.toml` symlink stays a link and the edit lands in the shared `~/.codex/config.toml`; never copy `config.toml` into a store (re-verify on a binary bump).
- A Codex access token lasts 240 hours (`exp` minus `iat` of a stored token) and codex refreshes proactively after eight days only while a process uses the store, so an account whose only holder is idle can reach expiry unrefreshed; read the lifetime from the token claims, never hard-code it (re-verify on a binary bump).
- Codex's shell tool passes the full parent environment to its children by default (`shell_environment_policy.ignore_default_excludes` defaults to true, rust-v0.159.2), which is how `TOKENMAXXING_CODEX_SUPERVISOR_ID` and `CODEX_HOME` reach an SDK consumer that bypasses the shim (re-verify on a binary bump).
- Verify `codex app-server` request shapes before changing `src/lib/compact.ts` with `codex app-server generate-json-schema --out <dir>` and the `definitions` (`InitializeParams`, `ThreadResumeParams`, `ThreadCompactStartParams`) in `codex_app_server_protocol.v2.schemas.json`, never from strings in the binary.
- The `codex@openai-codex` plugin runs through the shim on every call: its stop-time review gate runs `codex --version` and `codex app-server --help`, ignores `stop_hook_active` so each failure blocks the stop and reruns the gate, and its adversarial review starts a detached `app-server-broker` per workspace that runs a bare `codex app-server`, which borrows a pooled seat until the broker stops or the Claude session ends. A job that ends with `codex app-server connection closed`, or stalls silent after `Starting Codex task thread`, is checked first against `codexsupervisor.borrow_none` (`no usable account`, the shim fell back to the ambient login) in `tokenmaxxing.log` and the `codex-live/` holder records, then against the wrapper rate guard; stop your own broker by PID after checking its cwd and start time (plugin 1.0.6; re-verify on a plugin update).
- `codex exec ... "<prompt>"` started from a background shell prints `Reading additional input from stdin...` and never starts; pass the prompt on stdin: `codex exec --skip-git-repo-check -s read-only -C <repo> -o <out> - < prompt.txt`.
- Read codex source at the pinned tag, never through `gh api search/code`, which indexes the default branch and rate limits a burst of calls: fetch `https://raw.githubusercontent.com/openai/codex/<tag>/codex-rs/<path>` (create the parent directory first, or curl fails with `(23)`), list a directory with `gh api "repos/openai/codex/contents/<dir>?ref=<tag>"`, and cite `file:line` from the fetched copy.
- When a plugin or hook that spawns codex does nothing, compare its installed version (the plugin cache stays at its installed version until a plugin update) and the global tokenmaxxing version against their registries before reading code; a hook's stderr is invisible in Claude Code, so a failure shows only as silence.
