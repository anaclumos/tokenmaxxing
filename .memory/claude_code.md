# Claude Code internals

Verified mechanics of the Claude Code binary that the pool depends on. The binary changes monthly: re-verify against the installed binary before building on an entry. Supervisor, hook, and seat rules are in `AGENTS.md`; Codex is in [[codex]] and pi in [[pi]].

## Verification baseline

- Verified against Claude Code 2.1.204 through 2.1.286; re-check a line after each binary bump, and audit `CRED_ENV_OVERRIDES`, `MODEL_FAMILIES`, `SUBCOMMANDS`, and `VALUE_TAKING_ROOT_FLAGS` then.

## Credential store

- The store directory is `CLAUDE_SECURESTORAGE_CONFIG_DIR`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`, NFC-normalized; an empty value falls through.
- On Linux the store is a 0600 `.credentials.json` inside that directory and the build has no keyring path.
- On macOS the default store is the login-keychain item `Claude Code-credentials`; with the store variable set the item is `Claude Code-credentials-<first 8 hex of sha256(NFC(value))>`, hashed over the raw string, so the value must be byte-stable (a trailing slash or `~` names another item).
- A missing namespaced keychain item falls back to `<dir>/.credentials.json` and then to an empty credential, never to the default item.
- The binary reads `CLAUDE_CODE_OAUTH_TOKEN` (memoized per process), `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, the `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` and `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` inputs, the Bedrock, Vertex, Foundry, Mantle, Anthropic AWS, and Anthropic Google Cloud switches (`CLAUDE_CODE_USE_*`), `CLAUDE_CODE_SUBSCRIPTION_TYPE`, and `CLAUDE_CODE_RATE_LIMIT_TIER` before the store; `CRED_ENV_OVERRIDES` mirrors that list.
- Audit new switches with `strings <binary> | grep -oE 'CLAUDE_CODE_USE_[A-Z_]+' | sort -u`, and confirm an override with `claude auth status --json` under `env -i`, a throwaway `HOME`, a store holding a fake credential, and `unshare -rn`: an override changes `authMethod` or `apiProvider` from `claude.ai` and `firstParty`.
- `CLAUDE_CODE_USE_GATEWAY` alone keeps the store login.
- `ANTHROPIC_BASE_URL` keeps the store login and receives its bearer on `/v1/messages`; with `ANTHROPIC_AUTH_TOKEN` also set it receives that token instead. `CLAUDE_CODE_API_BASE_URL` carries no inference request.

## Refresh

- The client refreshes within 300 s of `expiresAt`, and force-refreshes at most twice per request loop on a 401 or a 403 `OAuth token has been revoked`.
- Each refresh check first stats `<store>/.credentials.json` and drops the memoized credential when the mtime moved; under the refresh lock it clears the memo, re-reads the store, and returns `refreshed` with no token request when the stored access token differs from the one it started with, so processes that share one store directory rotate the grant once (2.1.280 and 2.1.286).
- The rotated pair is written back under a compare-and-swap on `refreshToken` that also accepts an empty stored token, so a refresh result can overwrite a dead-cleared store; the `/login` save has no CAS.
- On `invalid_grant` the client dead-clears the store to empty tokens and `expiresAt` 0, as a compare-and-swap on the refresh token it sent, still under the refresh lock, and leaves the file in place; the in-memory credential has no TTL.
- The refresh takes the mkdir lock `<store>/.oauth_refresh.lock` (`realpath: false`, 60 s stale, 5 s update): `ELOCKED` is retried five times after 1 to 2 s each, then answers `lock_busy` when the lock's mtime moved and `lock_timeout` when it did not; a holder that looks dead is taken over through `.oauth_refresh.lock.owner` behind the `tengu_quiet_marten` gate.
- After the first lock it takes the legacy `<realpath(store)>.lock` beside the store: its `ELOCKED` releases the first lock and throws, any other error is logged and the refresh goes on under the first lock alone; it never refreshes unlocked.
- Every credential write takes the mkdir lock `<store>/.storage-write.lock` (15 s stale), re-reads the store under it, and replaces the file through a new 0600 `.credentials.json.tmp.<8 hex>` and a rename with no `chown`, writing in place on `EXDEV`, `EPERM`, `EEXIST`, or `EBUSY`; the replaced file belongs to the writer's uid.
- The refresh and write locks live inside the store directory: a process that shares a store needs the directory itself, read-write, under the store owner's uid, because a copied or single-file-mounted `.credentials.json` takes its locks elsewhere and a writer under another uid (root in a rootful container) leaves a file the owner cannot read.
- A running session adopts a store change on its next freshness poll (the file mtime on Linux, a 30 s keychain cache on macOS); a request stuck in a 429 retry keeps its token until that request dies.
- The token endpoint is `platform.claude.com/v1/oauth/token`; it rotates the refresh token on every success, and the rotated access token lasts 8 hours.
- A grant failure is the flat OAuth body `{"error":"invalid_grant",...}` (a superseded refresh token included); a request-validation failure (empty `refresh_token`, unknown client id, malformed body) is the nested `{"type":"error","error":{"type":"invalid_request_error",...}}` body, so recognize a dead-cleared store before any request.
- `claude -p /usage --no-session-persistence --safe-mode`, with the store variable set and a throwaway `CLAUDE_CONFIG_DIR` as its home and working directory, refreshes an expired store token and exits 0 in about 3 s (2.1.283): `/usage` makes no model call and opens no session window, `--no-session-persistence` writes no transcript, and without `--safe-mode` the child syncs the organization's skill bundle into the throwaway home.

## Identity and plan

- `GET api.anthropic.com/api/oauth/profile` (plain Bearer, `Content-Type: application/json`, no beta header) is what the binary calls to fill `oauthAccount`; `account.uuid` is the seat and `organization.uuid` is shared by every seat of a Team plan.
- `GET /api/oauth/claude_cli/roles` names only the organization and is not an identity.
- `/api/claude_cli_profile` answers 403 for a raw token (consumer-OAuth enforcement) while the usage, profile, and roles endpoints answer 200.
- The credential blob's `rateLimitTier` (`default_claude_max_20x`, `default_claude_max_5x`, `default_claude_zero`) is the only 5x/20x discriminator, because `subscriptionType` is `max` for both; parse the multiplier segment structurally.

## Usage figures

- Claude Code learns its limits from the `anthropic-ratelimit-unified-<window>-utilization`, `-reset`, and `-surpassed-threshold` headers of every model response (`5h`, `7d`, `7d_oi`, `overage`, plus `-status`), never from a poll, so a session shows figures for an account whose usage read answers 429 (2.1.286).
- In stream-json mode it writes a `rate_limit_event` line whose `rate_limit_info.unifiedWindows` carries `five_hour` and `seven_day` as `{utilization, resetsAt}` (a fraction above 1 past a cap, epoch seconds) each time either window's rounded percent or reset changes, and only then.
- It reads `GET /api/oauth/usage` itself only on demand: `/usage` (answered from `cachedUsageUtilization` in `~/.claude.json`, one slot for the last account, when under 60 s old and newer than the last header reading), the usage-credits flows, and the limit-reset offers fetched when a session hits a wall.
- Within one process it shares one in-flight `at_wall` read per account and remembers a refusal per bearer in memory: an auth rejection for an hour, a 429 for its `retry-after` (5 minutes without one), never longer than an hour.
- `probeQuotaStatus` (source `quota_check`) reads the headers with a 1-token `messages.create` whose content is `quota`; that is an inference request that opens the session window, so it is no sampler for an idle account.

## Limit reset

- The reset grants live in the `cedar_ember` block of the usage body, on the `at_wall=1&skip_spend=1` read as well as the binary's own `cedar_ember=1&skip_spend=1` read: `eligible`, `ineligible_reason`, `at_limit`, `next_grant_id`, `weekly_resets_at`, and `grants[]` with `id`, `resets_total`, `resets_left`, `clears` (window names such as `five_hour`, `seven_day`, `seven_day_overage_included`), `paused`, `usable_now`, `use_requires_limit`, `starts_at`, and `ends_at` (2.1.286).
- The server answers `ineligible_reason: "surface"` with no grants unless the read carries `User-Agent: claude-cli/<version> (external, cli)`; the same string without the version is refused too.
- The binary offers only the grant that `next_grant_id` names, and only while it is `usable_now`, not `paused`, and before `ends_at`.
- The claim is `POST /api/organizations/<organizationUuid>/reset_rate_limits` with `{"program": "cedar_ember", "grant_id": <id>, "request_id": <id>}` (a UUID passes the binary's request-id check), the OAuth bearer, and `anthropic-beta: oauth-2025-04-20`; the answer is `result` (`reset`, `already_used`, `not_limited`, `cooldown`, `ineligible`, `unavailable`) with `reason`, `resets_left`, `cleared`, and `weekly_resets_at`.
- A grant whose `use_requires_limit` is false is usable below the limit; the observed launch grant was.
- The older `juniper_tide` program (`resets_per_week`, `next_available_at`) is still in the body and is not what the binary claims for a grant.
- `/limit-reset` is interactive only (`supportsNonInteractive: false`, 2.1.263), so a claim from outside a session is the direct POST above.

## Hooks

- A subagent's StopFailure hook input carries the session transcript as `transcript_path` and no `agent_transcript_path` (only `SubagentStop` has that key); its rows, the error row included, go to `<session id>/subagents/agent-<agent id>.jsonl` beside it, or `<session id>/subagents/workflows/<run id>/agent-<agent id>.jsonl` for a Workflow agent (2.1.285).
- The StopFailure matcher is tested against the `error` kind: a matcher of only letters, digits, `_`, and `|` is split on `|` and each token matches exactly, and any other matcher is a regex (2.1.285). The hook is fire-and-forget and its exit code is ignored.
- A 401 or 403 whose message includes `OAuth authentication is currently not allowed for this organization` ends the turn with `error: "oauth_org_not_allowed"` on the hook stdin and on the row (`apiErrorStatus: 403`, no `quotaLimits`, text `Your organization has disabled Claude subscription access for Claude Code`).
- The full set of `error` kinds is `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`, `server_error`, `unknown`, `max_output_tokens`, and `cloud_credential_error`.
- The classifiable facts live on the transcript row: `isApiErrorMessage: true`, `apiErrorStatus: 429`, `message.model: "<synthetic>"`, and `quotaLimits.rateLimitType` in `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`, with `resetsAt` in epoch seconds copied from the response's rate-limit headers (`O6` in 2.1.286).
- `overage` is the binary's "usage credit limit"; a plan window that refuses with `overageStatus: "rejected"` and `overageDisabledReason: "out_of_credits"` keeps its own type and reads `You're out of usage credits`.
- The usage-credits refusal carries the typed `apiError: "model_requires_usage_credits"` and an `errorDetails` body with `error.type: "rate_limit_error"`; the client writes that row for a 429 whose body names `credits_required` or whose rate-limit headers name `seven_day_overage_included`, and in both cases the row carries no `quotaLimits`, only a text that follows the overage-disabled reason (`You're out of usage credits.`, `You've hit your monthly spend limit.`, `You've reached your Fable limit.`).
- The no-spend usage read can return `extra_usage: null`, so it is no source for an account's credit status.
- A transient 429 sets `apiErrorIsTransient`.
- `Stop` stdin has no error field and no usage data; hook output has no compaction field and cannot make the client wait.
- There is no `CLAUDE_CODE_DISABLE_HOOKS`; `--bare` disables hooks but also skips the keychain, and `--settings '{"disableAllHooks":true}'` disables them for one nested call.

## Statusline

- The main statusLine stdin carries `rate_limits.{five_hour,seven_day}` after every turn (300 ms debounce); `model` is the main-loop model and there is no `hook_event_name`.
- Subagent rows come only through the `subagentStatusLine` settings key: the client pipes base fields plus `tasks[]` (`id`, `name`, `type`, `status`, `description`, `label`, `startTime`, `model`, `effort`, `contextWindowSize`, `tokenCount`, `tokenSamples`, `cwd`) for every active task and reads back `{id, content}` JSON lines that replace that task's row (empty content hides it).
- ANSI is re-emitted through the client's own chalk: truecolor survives on a truecolor terminal and downsamples to 256 elsewhere, tmux clamps to 256 unless `CLAUDE_CODE_TMUX_TRUECOLOR=1`, and the line renders inside the client's dim wrapper.

## Processes and flags

- `claude daemon` and `bg-pty-host` sessions spawn the real versioned binary by absolute path, so they bypass PATH shims, run unsupervised, and keep an old version alive after an auto-update.
- A setup token (`sk-ant-oat01-`, one year, non-rotating, precedence above the store) is inference-only: `/usage` prints no percentages under it.
- `claude -p --resume <sid> /compact` writes into `<sid>.jsonl`: a landed compaction appends a `{"type":"system","subtype":"compact_boundary"}` row (`compactMetadata.trigger: "manual"`), and a refused one appends a `system` row of subtype `local_command` whose stderr text starts `Error during compaction` and still exits 0, so the exit code never proves a compaction.
- `claude-md-or-agents-md` is the default project-instruction mode since 2.1.277: a project with no `CLAUDE.md` loads `AGENTS.md` in its place, behind the `tengu_agents_md_mod` gate and the `instructionFiles` setting; when project instructions stop loading, check those two first.

## Policy constraint

- Anthropic does not allow third parties to offer claude.ai login or rate limits in their products, including agents built on the Agent SDK; tokenmaxxing is personal use of the owner's own accounts and ships no SDK or plugin surface.
