# tokenmaxxing - design

Automatic Claude Code account switching. You run `claude` exactly as always; every session starts on the pooled account with the most session-window headroom per running session, and when the account a session runs on crosses its bar (**90%** of the 5h session window or **98%** of a weekly window), tokenmaxxing resumes that session on a fresher account at a safe turn boundary. Works across many concurrent sessions at once, each on its own account; a fully depleted pool pauses a session with a countdown and auto-resumes at the soonest reset when it lands within `policy.maxWaitMs` (default 1h; further out, the session stays put rather than parking for hours).

> Scope: **Claude Code first (macOS + Linux, the latter since 2026-07-09).** Codex support landed in 0.13.0 (2026-07-16) with its own parallel state and supervisor; since 1.35.0 both run on one engine. Codex's verified internals live in AGENTS.md's Codex sections.
>
> Status: **implemented** (v0.1.0, 2026-07-09; per-account stores since 1.37.0, 2026-09-12). TypeScript on Bun, shipped as SOURCE with a bun-shebang bin (the compiled-binary distribution was deleted in 0.2.1); Zod validates every external-boundary payload, JSON config, es-toolkit for utilities, `flock(2)` via `bun:ffi`. Load-bearing external facts were adversarially verified against the `2.1.204` binary + docs when first shipped and re-verified against `2.1.269` for the store model (§2). What the acceptance gates showed is in §9.

---

## 1. Why there is a thin supervisor (and why that's the whole trick)

Claude Code namespaces its credential by `CLAUDE_SECURESTORAGE_CONFIG_DIR` (verified in the 2.1.269 binary, `xSe`/`y_`): the variable moves only the credential store (a `.credentials.json` inside that directory on Linux, a keychain item named `Claude Code-credentials-<sha256(dir)[0:8]>` on macOS), while `~/.claude` (settings, transcripts, plugins) and `~/.claude.json` stay shared, so `--resume` works across stores. An empty namespaced store never falls back to the default login. Hooks, the statusline, and MCP servers inherit the variable. That is the whole mechanism: give every pooled account its own store, set the variable per session, and each session runs on its own account with no credential ever moving.

What the variable cannot give you is a change of account for a running process: the store is fixed at spawn. So the supervisor's job is placement and moves: on launch it **picks the seat** (see §5) and spawns claude under that account's store; when the session's Stop hook decides the seat is over its bar, the supervisor **replaces the process at a salvageable moment** - after a turn completes, the conversation is fully written to the transcript JSONL and `claude` is idle at the prompt, so killing it there loses nothing - and relaunches `claude --resume <session-id>` under the target's store. When the whole pool is over its bars it shows an interruptible countdown to the soonest reset first. **Thresholds sit below 100: the headroom is the budget to reach a clean turn boundary before the account actually hits its real limit.** The session window moves at 90 (a 5h reset is cheap to sit out), while the weekly windows drain to 98 (weekly allowance is use-it-or-lose-it).

A hook can't do the placement or the relaunch - when `claude` exits, the shell owns the terminal. So tokenmaxxing installs a **supervisor** (aliased to `claude`) that owns the process lifecycle:

```
supervisor (you type `claude`)  →  real claude, CLAUDE_SECURESTORAGE_CONFIG_DIR=stores/<uuid8>  →  Stop hook
        ▲______________ relaunch --resume <sid> under another store ______________|
```

It is a process manager only - spawn with inherited stdio plus saved `stty -g` termios (not a PTY copy), wait, restore the terminal, relaunch. It never proxies API traffic and never handles tokens. Everything else about `claude` is unchanged.

---

## 2. What tokenmaxxing installs

- A `claude` **supervisor** on your PATH ahead of the real binary (`~/.config/tokenmaxxing/bin/claude`), or a shell function - you invoke it identically.
- Five `~/.claude/settings.json` entries (merged - other settings keys are preserved, but the `statusLine` slot is taken over): the tokenmaxxing `statusLine` renderer (native since 2026-07-11; it also tees usage), a `subagentStatusLine` (per-subagent rows in the agents panel), a `Stop` hook, a `StopFailure` hook, a `SessionStart` hook.
- **`~/.config/tokenmaxxing/`** - the single home for config and state:
  - `config.json` - SPARSE overrides only (thresholds.session/weekly, claudeBin/codexBin pins, policy.*); defaults apply at read time, `xx config` prints the path and the effective values, and edits happen in an editor.
  - `accounts.json` - non-secret index `{id, label, email, tier, windows, lastUsageAt, lastProbeAt, enforcedUntil, needsReauth, oauthAccount}` (each cached window carries its name, duration, reset, and sample time; the same shape serves the Codex pool as `codex-accounts.json`). `activeId` is `null` for both pools: there is no pool-wide active account.
  - `stores/<uuid8>/` - one Claude Code credential store per pooled account (see below).
  - `codex-stores/<uuid8>/` - one Codex credential store per pooled account: its `auth.json`, with everything else symlinked to the shared `~/.codex` so sessions, history, and config stay shared and `codex resume` works across stores.
  - `usage/<uuid8>.json` - the statusline tee per account, written by the sessions running on it.
  - `live/<session-id>` - PID-validated presence per supervised session, naming its account; placement counts them.
  - `respawn/<session-id>` - per-session respawn markers (the hook→supervisor signal): the target account plus a `waitUntil`.
  - `bin/claude` - the supervisor.
- Per-account **credential stores** follow the platform's Claude Code store: macOS = a login-keychain item keyed by the store path (never plaintext on disk); Linux = a 0600 `.credentials.json` inside the 0700 store directory (the same plaintext model claude itself uses - its Linux build has no keyring path at all, binary-verified 2.1.205). One `credstore` facade dispatches on a `{kind: keychain|file}` target; call sites never branch on platform. tokenmaxxing writes a store once, at onboarding; Claude Code's own refresh is the only writer afterwards.

- A periodic check job (`com.tokenmaxxing.check` launchd agent on macOS, `tokenmaxxing-check.timer` systemd user timer on Linux) running `tokenmaxxing check` once per tick (`policy.checkIntervalMs`, 60s by default): it folds fresh tees into the index and samples the accounts whose `/usage` figures are oldest (up to three per tick), so the cached figures every placement reads stay fresh.

The switching path runs no long-lived daemon. The statusline pushes usage. Hooks and the supervisor react. The periodic check job above is the only recurring process. The `claude` binary, `~/.claude`, `~/.claude.json`, and Claude Code's default credential store are untouched.

---

## 3. How a move happens

### 3.1 Usage feed (free, push-based)
The Stop hook's stdin has no usage data, but the **statusLine does** (`rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`, after every turn, 300ms debounce, zero cost). tokenmaxxing's statusLine tees that to `usage/<uuid8>.json` for the session's seat, read from the inherited `CLAUDE_SECURESTORAGE_CONFIG_DIR` (write-on-change, O(ms)), and renders its own native line (it replaced the earlier pass-through delegation on 2026-07-11: install takes the statusLine slot outright, so a pre-existing custom statusline command is overwritten). A session with no pooled seat writes no tee. Cold-start fallback when the seat has no tee: `TOKENMAXXING_PROBE=1 claude -p '/usage'` under the seat's store, with a throwaway `CLAUDE_CONFIG_DIR` so no hooks load and `[ -n "$TOKENMAXXING_PROBE" ] && exit 0` as every hook's first line to stop the nested process recursing (hooks fire in `-p` too). The probe scrubs every ambient credential override claude reads before the store (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, etc.) and then sets the store it means to read, and retries the transient empty-footer case (claude prints local stats with no percentages when its own usage fetch throttles).

### 3.2 Detect + decide + signal (Stop hook, per turn)
1. Resolve the seat: the pooled account whose store the inherited `CLAUDE_SECURESTORAGE_CONFIG_DIR` names. No seat (a session started outside the supervisor) means nothing to move.
2. Read the seat's tee and exit while it is under both bars, as defined in the [switching policy](docs/content/docs/switching.mdx).
3. Take the pool lock, re-check, fold every account's tee into the index, select a candidate under the switching policy from the cached figures, and verify that the target's store holds a usable credential (a store Claude Code dead-cleared flags the account for re-auth and the next candidate is tried).
4. Write `respawn/<session-id>` (atomic temp+rename) naming the target, with `waitUntil` now for a plain move or the soonest reset when the pool is depleted. No credential is written.

### 3.3 Move and depleted-pool pause (supervisor)
The supervisor sees `respawn/<sid>`, SIGTERMs its child at the already-committed turn boundary, deletes the marker, resets the terminal, compacts the conversation when the marker asks for it (`compact: true` from the Stop and SessionStart hooks, `false` from StopFailure: it runs `claude -p --resume <sid> /compact` under the old seat's store, bounded at five minutes, and a failure only prints why), and (when `waitUntil` is in the future) shows an interruptible countdown to the reset; then it relaunches `claude --resume <sid>` with `CLAUDE_SECURESTORAGE_CONFIG_DIR` set to the target's store and rewrites the session's presence. The resumed process reads that store cold → runs on the target account, same conversation. The `SessionStart` hook (source `resume`) re-runs the decision before the first turn and writes the same marker if the seat is already over its bar or the pool is depleted. A marker that fails to parse is never deleted and treated as absent: the supervisor stops the child, restores the terminal, and exits naming the marker path.

### 3.4 Placement (supervisor, under the pool lock)
1. Fold every account's tee into the index.
2. Rank the usable accounts (§5) with the live session counts from `live/`, or the soonest-recovering account when none is usable; with no pooled account or every account needing re-auth, launch without a store (unmanaged).
3. Spawn claude with the store env set, then write `live/<sid>` with the child's pid and start time. The lock covers the pick and the presence write, so concurrent launches see each other.

### 3.5 Multiple concurrent sessions
Each terminal ran the supervisor, so each has its own child `claude`, its own `--session-id`, its own seat, and its own presence file. Sessions spread over the pool at launch (the second launch never lands on the first's account while another fresh account exists), sessions on one account share its store and coordinate refreshes through Claude Code's own store-rooted refresh lock, and each session moves on its own seat's figures. A move never touches another session. Only a shared state read is serialized: the pool lock covers decisions, placement, and the sampler's reservation, never a `/usage` child.

---

## 4. Onboarding (no `adopt`)

- **`tokenmaxxing init` logs your first pooled account in through an isolated browser sign-in, even if you are already signed in.** The login runs in a throwaway `CLAUDE_CONFIG_DIR=~/.config/tokenmaxxing/onboard`, its token's owner is verified through the profile endpoint (`GET /api/oauth/profile`, matched on `account.uuid`), and the credential is harvested once into that account's store; the throwaway home and its credential item are deleted. The login you already had keeps its own grant in Claude Code's default store for sessions started outside the supervisor; it is never copied, because a copy of one grant in two stores dies at the first refresh. `init` also installs the supervisor + the five settings entries.
- **`tokenmaxxing add`** - registers *additional* accounts the same way, one store each. `CLAUDE_CONFIG_DIR` is SET by tokenmaxxing only for throwaway homes like this one and the probe homes under `sample/`; a session's store is always set through `CLAUDE_SECURESTORAGE_CONFIG_DIR`.
- **`tokenmaxxing auth [sel | --all]`** - reauthenticates an *existing* pool member whose store died (a needs-reauth account can never heal on its own: the dead grant is exactly what Claude Code's refresh would need). Same isolated-login harvest as `add`, but it states which email to sign in with and **requires the login to land on the target account** (verified `accountUuid` must match, else nothing changes). Bare `auth` lists the pool with emails and asks which; `--all` walks every flagged account one by one.
- Both commands exercise `security` reads/writes interactively (where a macOS keychain ACL prompt is acceptable), so the first access never happens cold inside a headless hook.

---

## 5. Placement and rotation policy
The [switching policy](docs/content/docs/switching.mdx) is one rule: under both bars, hold; at or over a bar, move to the usable account that ranks first; nothing usable, wait for the soonest reset. The same ranking places a session at launch.

- Ranking (decided by consult for #79): greatest remaining headroom to the session bar divided by the number of sessions after placement, `(bar - used) / (sessions + 1)`, then highest weekly pace pressure (remaining weekly percent over time to the weekly reset), then soonest weekly reset, then lowest weekly usage; unknown usage ranks last. Organization membership is not an input. Codex keeps the pure pace ordering and excludes accounts running in another codex session, because codex has no cross-process refresh lock and two sessions must never share a login.
- Selection reads the cached figures only, after folding every account's tee. Each periodic check tick samples up to three accounts whose last `/usage` attempt is oldest, skipping any attempted within `policy.usagePollTtlMs`, under each account's store, so every account is attempted about once per three ticks per pooled account, or once per `policy.usagePollTtlMs` plus a tick when that is longer, and its cached figure is as fresh as its last successful attempt or its sessions' latest push. The pool lock covers only the reservation and the result write, never the `/usage` child.
- The depleted pause happens at the bar, not at 100; Codex has no pause and rides its account until the server refuses it, because a running sibling cannot adopt another account without restarting.
- Neither pool has a post-swap cooldown or a manual `switch`: a move is a respawn of one session under a fixed store, so nothing another session reads is invalidated by it, and placement at launch replaces the manual pick.

The [profile](docs/content/docs/switching-profile.mdx) records observed cache rewrites across swaps and does not infer subscription quota savings.

**Model-aware trigger.** Claude subscriptions also enforce **per-model weekly caps** - currently only for Sonnet and Fable (there is no Opus-only quota), and Fable's tighter limit binds *before* the aggregate (e.g. 80% week-Fable at only 50% week-all-models). This cap isn't in statusLine stdin, so when the active model is in `policy.switchModels` we read it from `claude -p '/usage'` under the seat's store (free, 0 tokens, TTL-cached) and add `week(<activeModel>) >= threshold` to the trigger. A Fable session moves on the Fable cap; a Sonnet session rides the aggregate. Candidate screening applies the same per-model gate: a burnt Fable cap screens an account out of a move, and a launch, whose model is unknown, gates every configured family.

---

## 6. Honest papercuts
- **A move restarts the process.** Every move is a `claude` stop and `--resume`; anything typed in the split second before the SIGTERM is lost, the supervisor resets terminal mode so nothing is left garbled, and the first turn on the new account re-uploads context once (prompt cache is org-scoped). A bar-triggered move compacts on the old account first so that upload is the summary, not the transcript; a move after a refusal cannot, and re-uploads the full context.
- **Single-turn overshoot.** If one turn jumps from under the threshold straight past the wall, that turn ends rate-limited; the StopFailure hook walls the seat and moves the session, and the next prompt continues the conversation on the fresh account. The static session-bar margin (`policy.projectionMargin`, default 3) reduces this.
- **Unsupervised sessions are not moved.** A claude started outside the supervisor runs on whatever login its environment names, by default Claude Code's default store, which tokenmaxxing never writes.
- **One shared identity file.** `~/.claude.json` keeps a single `oauthAccount`, which Claude Code rewrites after whichever session refreshed last, so `/status` can show another session's email. The store decides which credential a session uses.
- **Dead stores.** A refresh Claude Code cannot complete dead-clears the store; the sampler and the decision recognize the empty tokens without a request, flag the account, and `auth` repairs it in place.
- **statusLine fragility.** The native statusline is the most visible surface - a bug flickers or blanks the line for every session (and install takes the slot outright, replacing any custom statusline you had). Keep it O(ms), write-on-change.
- **Keychain blob size & ps-safety.** A store's keychain item also holds per-MCP-server OAuth state once Claude Code writes it, so it can exceed `security -i`'s ~4KB interactive line buffer (verified on a real machine - a 4.3KB blob truncated). tokenmaxxing's one write, the onboarding harvest, stores the **`claudeAiOauth`-only** object (small → always the ps-safe stdin write) and never rewrites a store afterwards.
- **settings.json is user-owned.** Install by merge; ship `tokenmaxxing doctor` to verify the supervisor + 5 entries survive a `/config` edit or update.

---

## 7. Scope
**v1:** `tokenmaxxing init` / `add` / `ls` (removed in 1.30.0, `status --cached` covers it) / `status` / `doctor`; the supervisor; statusLine shim + Stop/StopFailure/SessionStart hooks; per-session placement and moves by respawn with `flock` + reset-aware picker; platform credential stores (macOS keychain / Linux 0600 files, one facade). macOS + Linux.

**v2:** projected-threshold pre-emption; a `UserPromptSubmit` guard that respawns *before* a turn starts when already over; Windows.

**Removed (1.23.0):** the programmatic SDK surface, the stdio MCP server, and the Agent Plugin that shipped from 0.11.0 through 1.22.0. The CLI, the hooks, and the supervisor are the only surfaces.

**Removed (1.37.0, issue #79):** the shared live credential and everything that served it: the swap-time harvest, park, and install, tokenmaxxing's own OAuth refresh grant and its interlock with Claude Code's refresh lock, the `~/.claude.json` `oauthAccount` rewrite, the 45-second post-swap cooldown, the pool-wide depleted-wait record, the parked-credential slots (`creds/`, `tokenmaxxing-cred-*`), the ambient `CLAUDE_CONFIG_DIR` refusal, and manual `switch` for the Claude pool.

**Shipped since (0.13.0):** Codex as a second pool with its own state (`codex-accounts.json`, per-account `codex-stores/`, own flock). Since 1.35.0 the engine is one: a generic account record (`id`, `label`, `email`, `tier`, `windows`), one picker, one decision, and one set of account commands run against a `Provider` (`src/lib/provider.ts`); `src/lib/claude.ts` and `src/lib/codex.ts` hold only what differs per product (credential store, identity, usage source, presence, login and install flows), and the provider's `seats` capability (`shared` for Claude, `live` for Codex) is how the engine knows whether present accounts stay candidates and whether a move needs the caller's respawn. Codex differences that shaped it: restart IS the switch (a running codex refuses another account's credential), one store per pooled account with `CODEX_HOME` set per session (everything but `auth.json` symlinked to the shared home, so resume works across stores), usage is a free direct GET with epoch resets and a duration-classified window set (the weekly window is primary on current plans), the refresh token rotates with reuse punished (persisted into the account's own store the instant it returns, never refreshed for an account running in another session), and the codex Stop hook drives the auto-switch through a codex supervisor shim that respawns `codex resume <session-id>` under the target's store (hooks must be trusted once via `/hooks`).

**Shipped since (1.29.0):** a Cursor Cloud relay. A cloud VM has no keychain, no pool state, and no supervisor, so the path uses what it does have (environment variables, a shell, repo files) and a different credential primitive, one-year inference-only setup tokens, minted once per pooled account by `tokenmaxxing setup-token` on the owner's machine and carried to the VM as one user-scoped Runtime Secret (`TOKENMAXXING_TOKENS`). `tokenmaxxing cursor init` writes a `claude` project subagent (`.cursor/agents/claude.md`) that forwards each task to `tokenmaxxing cloud run`, which spawns `claude -p --dangerously-skip-permissions --output-format json` under `CLAUDE_CODE_OAUTH_TOKEN` and pins the thread to that token (the API caches by exact prefix, so a rotation busts one thread, not all). A setup token carries no usage signal, so rotation is reactive. A run whose transcript gained a non-transient rate-limit row during that run (the structured row the StopFailure hook reads) walls the label until the reset the row names (five hours without one) and resumes the same session on the next token; the result's `api_error_status` alone never walls, so a transient 429 or an older row from a previous token does not cascade across the pool. The local switching engine never reads a setup token; `/usage` prints no percentages under one. Details in [Cursor Cloud](docs/content/docs/cursor-cloud.mdx).

**Non-goals:** an API/MITM proxy; reimplementing OAuth beyond the read-only identity check at onboarding; Slack as a message bus; soft concurrency caps.

---

## 8. Stack
TypeScript on Bun, shipped as source: one multi-call entry (`src/main.ts`, `#!/usr/bin/env bun`) serves the CLI, the `claude` supervisor, the statusLine shim, and the hooks; `init` installs a 2-line shim that `exec`s bun on the installed package's entry (the Stop path runs every turn; bun's start-up stays low-millisecond). Published to npm as `tokenmaxxing` (source, platform-independent - a compiled binary was tried and shipped one architecture's Mach-O to every platform). Shipping is PR-based since 2026-07-18: work reaches main only through a pull request (branch, PR, CI green, a 10-minute review wait, every review handled, merge, teardown), and a release is a PR-landed version bump followed by `gh release create` (details in AGENTS.md "Release and CI"). The supervisor spawns claude with inherited stdio and restores saved `stty -g` termios between runs - no PTY layer; resize and signals flow through the shared foreground process group.

---

## 9. What the acceptance gates showed

### 2026-09-12 (per-account stores, 1.37.0)

Hermetic run on Linux under a throwaway `HOME` and `TOKENMAXXING_HOME`, a stub `claude` that records its environment and answers `-p /usage` from a per-store fixture, and a synthetic three-account version 2 pool with equal headroom on two accounts and the third over its session bar:

1. **Placement - ✅.** The first supervised launch spawned the stub with `CLAUDE_SECURESTORAGE_CONFIG_DIR=stores/<first account>` and wrote its presence; the second launch, with equal headroom, landed on the other account.
2. **Plain move - ✅.** A 95% session tee for the second session's account made its Stop hook write the marker; the supervisor relaunched `--resume <sid>` under the first account's store within a second and rewrote the presence file.
3. **Wall move - ✅.** A five-hour refusal row fed to the first session's StopFailure hook stamped `enforcedUntil` on its seat and moved the session to the account that had just been freed; a Stop hook on the walled seat moved the remaining session off it too.
4. **Sampling - ✅.** The check tick probed the stalest account under its store with the `-tick` probe home; live `status` probed the accounts without a fresh tee under their stores and read the one with a fresh tee from the tee.
5. **Stores never move - ✅.** SHA-256 of every store's `.credentials.json` was identical before and after; no `creds/` directory and no root `usage.json` appeared; the SessionStart hook on a seat under its bars wrote no marker; stopping the children cleared every presence file.

The `pooledSpawnEnv` helper the issue names left with the SDK surface in 1.23.0; the supervisor's launch environment is the one spawn-env site.

### 2026-07-09 (v0.1.0)

Unit suite: **32 pass**. Hermetic swap+concurrency+model-aware E2E: **all pass**. CLI init/doctor/uninstall: **pass** (re-verified init/doctor 2026-07-09 through the npm-installed bun shim on linux-arm64 after the switch to source packaging; full suite 47 pass / 0 fail there). Transcript continuity across a process boundary was proven on a real account (`claude --session-id X -p ...` then `claude --resume X -p ...` recalled the earlier turn), the kill→restore-termios→respawn→`--resume` loop with a mock claude, headless keychain writes through `security -i`, and a concurrent flocked decision with 4 racing processes. The test suite itself was deleted on 2026-09-02 (owner ruling); verification since is the typecheck plus hermetic CLI runs.

Owed before fully trusting in the wild: the live interactive-PTY SIGTERM/terminal test (the owner declined it once), and a live run with two real subscription accounts observing placement and a move end to end.
