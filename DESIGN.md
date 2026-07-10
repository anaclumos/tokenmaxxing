# tokenmaxxing - design

Automatic Claude Code account switching. You run `claude` exactly as always; when the active account crosses **95%** usage, tokenmaxxing swaps to a fresh account and - at the next safe turn boundary - **restarts your session resumed on it, automatically**. Works across many concurrent sessions at once.

> Scope: **Claude Code only, macOS first.** Codex and other CLIs deferred (see `.memory/cc-codex-auth-mechanics.md`).
>
> Status: **implemented** (v0.1.0, 2026-07-09). TypeScript on Bun → single binary; Zod validates every external-boundary payload, JSON config, es-toolkit for utilities, `flock(2)` via `bun:ffi`. All load-bearing external facts were adversarially verified against the `2.1.204` binary + docs (OAuth token endpoint is `platform.claude.com/v1/oauth/token`, client_id `9d1c250a-...`, JSON body). What the acceptance gate actually shows is in §9.

---

## 1. Why there is a thin supervisor (and why that's the whole trick)

A **running** `claude` cannot adopt a swapped credential mid-flight - binary-verified: it holds its OAuth token in memory and a 429 (the limit event) does **not** invalidate it, so it never re-reads the keychain on the event we care about. A keychain swap is only picked up by a **fresh** `claude` process.

The clean way to exploit that is not to fight the live process but to **replace it at a salvageable moment**: after a turn completes, the conversation is fully written to the transcript JSONL and `claude` is idle at the prompt - killing it there loses nothing, and a `claude --resume <session-id>` comes back cold on the new account and continues exactly where it left off. **This is why we swap at 95%: the 5% headroom is the budget to reach a clean turn boundary and respawn before the account actually hits the wall.**

A hook can't do the respawn - when `claude` exits, the shell owns the terminal. So tokenmaxxing installs a **supervisor** (aliased to `claude`) that owns the process lifecycle:

```
supervisor (you type `claude`)  →  real claude (in a PTY)  →  Stop hook
        ▲_______________ relaunch --resume <sid> ______________|
```

It is a process/PTY manager only - spawn, forward the terminal, wait, restore terminal, relaunch. It never proxies API traffic or handles tokens. Everything else about `claude` is unchanged.

---

## 2. What tokenmaxxing installs

- A `claude` **supervisor** on your PATH ahead of the real binary (`~/.config/tokenmaxxing/bin/claude`), or a shell function - you invoke it identically.
- Three `~/.claude/settings.json` entries (merged, preserving anything you already have): a transparent `statusLine` shim, a `Stop` hook, a `SessionStart` hook.
- **`~/.config/tokenmaxxing/`** - the single home for config and state:
  - `config.json` - threshold, account order/policy.
  - `accounts.json` - non-secret index `{email, organizationUuid, accountUuid, lastUsage, resetsAt, needs_reauth}`.
  - `usage.json` - live usage, written by the statusLine shim.
  - `respawn/<session-id>` - per-session respawn markers (the hook→supervisor signal).
  - `bin/claude` - the supervisor.
- Per-account **credentials** follow the platform's Claude Code store: macOS = login-keychain items `tokenmaxxing-cred-<accountUuid[:8]>` (never plaintext on disk); Linux = 0600 files `creds/tokenmaxxing-cred-<accountUuid[:8]>.json` (the same plaintext model claude itself uses - its Linux build has no keyring path at all, binary-verified 2.1.205). One `credstore` facade dispatches on a `{kind: keychain|file}` target; call sites never branch on platform.

No background daemon - it's event-driven (statusline pushes usage; hooks + supervisor react). The `claude` binary and `~/.claude` layout are untouched.

---

## 3. How a switch happens

### 3.1 Usage feed (free, push-based)
The Stop hook's stdin has no usage data, but the **statusLine does** (`rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`, after every turn, 300ms debounce, zero cost). tokenmaxxing's statusLine shim tees that to `usage.json` (write-on-change, O(ms)) and passes your real statusline through unchanged. Cold-start fallback if `usage.json` is absent: `TOKENMAXXING_PROBE=1 claude -p '/usage'`, with `[ -n "$TOKENMAXXING_PROBE" ] && exit 0` as the hook's first line to stop the nested process recursing (hooks fire in `-p` too). The probe scrubs every ambient credential override claude reads before the keychain (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, etc.) so it can only meter the credential in the keychain item, and retries the transient empty-footer case (claude prints local stats with no percentages when its own usage fetch throttles).

### 3.2 Detect + swap + signal (Stop hook, per turn)
1. Read `usage.json`; `exit 0` fast if both windows `< 95%` (metered per `organizationUuid`).
2. Else take a `flock` on `~/.config/tokenmaxxing/lock`, re-check under it (parallel sessions race - first winner already swapped), pick the best parked account (not rate-limited, soonest-expiring weekly window first since unused allowance is forfeited at the fixed per-account reset, lowest 7-day usage tiebreak), and **swap the credential** (§3.4).
3. Write `respawn/<session_id>` (atomic temp+rename) and `SIGTERM` the parent `claude` (`kill -TERM $PPID`). The turn is already committed, so this is a clean stop.

### 3.3 Respawn (supervisor)
The supervisor's `claude` call returns; it sees `respawn/<sid>`, deletes it, resets the terminal, prints `↻ switched to <account>`, and relaunches `claude --resume <sid>`. The resumed process reads the keychain cold → runs on the new account, same conversation. The `SessionStart` hook (source `resume`) re-checks the account before the first turn as a backstop.

### 3.4 Swap sequence (under the lock)
1. **Harvest the live credential into its TRUE owner's backup** - read the current `Claude Code-credentials` blob and resolve which account it actually belongs to via the roles endpoint (`GET /api/oauth/claude_cli/roles`), NOT the `accounts.json` active label. The label drifts from the live blob (a kill mid-swap, a manual `/login`), and harvesting by label once overwrote another account's backup and destroyed its only credential. Mandatory anyway: Claude rotates the refresh token in place, so older backups are dead. Refuse the swap if the live credential belongs to no pooled account.
2. **Refresh B** - OAuth refresh-grant with B's parked refresh token → fresh access token; persist the rotated refresh token. On `invalid_grant`, mark B `needs_reauth`, notify, try the next account.
3. **Install B** - `security add-generic-password -U ... 'Claude Code-credentials' ...` with B's fresh (non-expired) `claudeAiOauth` JSON.
4. **Swap identity + mark B active** - atomically rewrite only the `oauthAccount` object in `~/.claude.json` (temp+rename) to B's, and write `activeAccountUuid = B` in the SAME critical section, so a crash can't leave the installed credential and the active label pointing at different accounts.
5. Do steps 1, 3, 4 inside Claude's own `~/.claude.lock` so the writes can't collide with a token refresh.

### 3.5 Multiple concurrent sessions
Each terminal ran the supervisor, so each has its own child `claude`, its own `--session-id`, and its own respawn marker. When the shared account hits 95%, the first Stop hook to win the `flock` performs the one swap; **every** session's Stop hook writes its own respawn marker and SIGTERMs its own `claude`; **every** supervisor independently relaunches `claude --resume <its-own-sid>`. All of them come back on the new account, each continuing its own conversation. (They share one credential, so they always move together - consistent with "one current account, many windows.")

---

## 4. Onboarding (no `adopt`)

- **`tokenmaxxing init` imports the account you're already on - automatically, no prompts, no re-login.** It reads the live `Claude Code-credentials` keychain blob plus the `oauthAccount` object in `~/.claude.json` (email, `organizationUuid`, `accountUuid`, plan tier) and writes them as **account #1** into tokenmaxxing's store (`tokenmaxxing-cred-<accountUuid[:8]>` + an `accounts.json` index entry). Nothing about your current session changes - that account stays active; it's now just also a registered pool member. After this one command you already have a working (single-account) pool. `init` also installs the supervisor + the three settings entries.
  - If the current auth is API-key mode (`ANTHROPIC_API_KEY`/`apiKeyHelper`) rather than a subscription `/login`, there's no quota-poolable subscription credential to import - `init` says so and points you to `/login` first (per-token API billing isn't what tokenmaxxing pools).
- **`tokenmaxxing add`** - registers *additional* accounts: logs one in via a throwaway `CLAUDE_CONFIG_DIR=~/.config/tokenmaxxing/onboard` (your primary login untouched), harvests it into the store, deletes the temp dir + its namespaced item. This is the **only** time `CLAUDE_CONFIG_DIR` is ever used.
- Both commands exercise `security` reads/writes interactively (where a macOS keychain ACL prompt is acceptable), so the first access never happens cold inside a headless hook.

---

## 5. Rotation policy
Trigger at `five_hour >= 95%` OR `seven_day >= 95%`, per org. "Exhausted" is a **timestamped state** (`resets_at`), not a flag - an account is a candidate again after it resets. Optional projected threshold (`95 − EMA(per-turn Δ%)`) so a single large turn can't blow past 100% before the next Stop hook.

**Model-aware trigger.** Claude subscriptions also enforce a **per-model weekly cap** - the capable models (Fable, Opus) have a tighter weekly limit that binds *before* the aggregate (e.g. 80% week-Fable at only 50% week-all-models). This cap isn't in statusLine stdin, so when the active model is in `policy.switchModels` we read it from `claude -p '/usage'` (free, 0 tokens, TTL-cached) and add `week(<activeModel>) >= threshold` to the trigger. A Fable session switches on the Fable cap; a Sonnet session rides the aggregate.

---

## 6. Honest papercuts
- **Respawn hiccup.** At the swap turn you see `claude` restart (~1–2s) and resume. Anything you typed in the split second before respawn is lost - mitigate by respawning fast and showing a clear "switching" state; the supervisor resets terminal mode so nothing is left garbled.
- **One cold turn.** Prompt cache is org-scoped: the first turn after resuming on B re-uploads context once (bigger on long transcripts).
- **Single-turn overshoot.** If one turn jumps from <95% straight past the wall, that turn can end rate-limited before the Stop hook swaps; the respawn then still recovers it. Projected threshold reduces this.
- **Shared blast radius.** All default-profile sessions share one keychain item, so a swap moves them all (each via its own respawn). The `flock` + re-check is mandatory or racing hooks burn two accounts at once.
- **Refresh-token rotation / parked-token rot.** Step 1 re-harvest is mandatory; a parked refresh token can be invalidated by logging in elsewhere → picker must catch `invalid_grant`, mark `needs_reauth`, fall through.
- **statusLine fragility.** The shim is the most visible surface - a bug flickers or breaks your real status line. Keep it O(ms), write-on-change.
- **Keychain blob size & ps-safety.** The live `Claude Code-credentials` item also holds per-MCP-server OAuth state, so it can exceed `security -i`'s ~4KB interactive line buffer (verified on a real machine - a 4.3KB blob truncated). tokenmaxxing therefore stores parked backups as **`claudeAiOauth`-only** (small → always the ps-safe stdin write) and, on a swap, **merges** the fresh `claudeAiOauth` into the *current* live blob so MCP tokens survive the switch - using the argv write path (secret briefly visible in `ps` on your own machine) only for that one oversized live write.
- **settings.json is user-owned.** Install by merge; ship `tokenmaxxing doctor` to verify the supervisor + 3 entries survive a `/config` edit or update.

---

## 7. Scope
**v1:** `tokenmaxxing init` / `add` / `ls` / `status` / `doctor`; the supervisor; statusLine shim + Stop/SessionStart hooks; 95% swap with `flock` + reset-aware picker; platform credential store (macOS keychain / Linux 0600 files, one facade); auto-respawn across concurrent sessions. macOS + Linux.

**v2:** projected-threshold pre-emption; a `UserPromptSubmit` guard that respawns *before* a turn starts when already over; Windows.

**Later:** Codex as a second pool; tool-agnostic picker.

**Non-goals:** an API/MITM proxy; reimplementing OAuth beyond the single refresh-grant call in the swap.

---

## 8. Stack
TypeScript on Bun, shipped as source: one multi-call entry (`src/main.ts`, `#!/usr/bin/env bun`) serves the CLI, the `claude` supervisor, the statusLine shim, and the hooks; `init` installs a 2-line shim that `exec`s bun on the installed package's entry (the Stop path runs every turn; bun's start-up stays low-millisecond). Published to npm as `tokenmaxxing` (source, platform-independent - a compiled binary was tried and shipped one architecture's Mach-O to every platform). The supervisor needs a real PTY layer (spawn claude on a pty, forward resize/signals, restore mode between runs).

---

## 9. What the acceptance gate showed (2026-07-09)

Unit suite: **32 pass**. Hermetic swap+concurrency+model-aware E2E: **all pass**. CLI init/doctor/uninstall: **pass** (re-verified init/doctor 2026-07-09 through the npm-installed bun shim on linux-arm64 after the switch to source packaging; full suite 47 pass / 0 fail there).

1. **Transcript continuity across a process boundary - ✅ proven on real claude/real account.** `claude --session-id X -p ...` committed a clean 12-line transcript; `claude --resume X -p ...` recalled the earlier turn's codeword. The supervisor's kill→restore-termios→respawn→`--resume` loop is proven with a mock claude. The one step not run live is the abrupt SIGTERM of an *idle interactive* real claude (structurally safe - the transcript is fully committed+fsynced before idle and nothing writes while idle).
2. **Terminal restoration - ✅ mechanism proven.** The supervisor saves `stty -g` and restores it between kill and respawn; the path executes in the mock-supervisor run. Visual raw-mode/​resize confirmation wants a live interactive terminal.
3. **SessionStart swap - ✅ swap logic proven; ⚠️ "adopted by first turn" needs a 2nd real account.** The hook's decision+swap path is covered by the E2E; the claude-internal timing (SessionStart before first `getToken`) needs a second subscription to observe end-to-end.
4. **Keychain writes from a headless hook - ✅ proven.** The swap E2E's 4 concurrent subprocesses each wrote the live item via `security -i` (secret on stdin, never argv) with no prompt/hang; `init` parked backups headlessly too. (Residual: the live `Claude Code-credentials` ACL for the *fresh resumed claude* is mitigated by onboarding touching `security` interactively.)
5. **Concurrent flocked swap - ✅ proven.** 4 concurrent processes racing the trigger → exactly **one** `flock`ed swap, one OAuth refresh, all end on B. Per-supervisor respawn is proven with the mock; N *real* supervisors respawning together needs real accounts + PTYs.
6. **Model-aware trigger - ✅ proven.** Fable at 96% per-model cap (aggregate only 30/50) → swaps; Sonnet at 96% → no swap.

Owed before fully trusting in the wild: the live interactive-PTY SIGTERM/terminal test, and the two items that require a **second real subscription account** (SessionStart adoption, N real supervisors).
```
