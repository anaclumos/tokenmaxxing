# tokenmaxxing - design

Automatic Claude Code account switching. You run `claude` exactly as always; when the active account crosses its swap threshold (the active rung of the 5h session ladder, **90** by default, or **98%** of a weekly window), tokenmaxxing swaps the credential to a fresh account at a safe turn boundary and **your running session adopts it in place - no restart**. Works across many concurrent sessions at once; a fully depleted pool pauses with a countdown and auto-resumes at the soonest reset when it lands within `policy.maxWaitMs` (default 1h; further out, the session stays put rather than parking for hours).

> Scope: **Claude Code first (macOS + Linux, the latter since 2026-07-09).** Codex support landed in 0.13.0 (2026-07-16) with its own parallel state, decision engine, and supervisor; its verified internals live in AGENTS.md's Codex sections.
>
> Status: **implemented** (v0.1.0, 2026-07-09). TypeScript on Bun, shipped as SOURCE with a bun-shebang bin (the compiled-binary distribution was deleted in 0.2.1); Zod validates every external-boundary payload, JSON config, es-toolkit for utilities, `flock(2)` via `bun:ffi`. All load-bearing external facts were adversarially verified against the `2.1.204` binary + docs (OAuth token endpoint is `platform.claude.com/v1/oauth/token`, client_id `9d1c250a-...`, JSON body). What the acceptance gate actually shows is in §9.

---

## 1. Why there is a thin supervisor (and why that's the whole trick)

A **running** `claude` DOES adopt an externally swapped credential (verified live 2026-07-10, correcting this document's original claim): an ensure-fresh poll re-reads the credential store around every request, so a swap lands within ~30s on macOS (raw keychain cache) and on the next request on Linux. A plain swap therefore needs no process management at all (since 0.15.0, 2026-07-16; earlier versions respawned on every swap): the Stop hook swaps the credential and the session keeps running. What adoption cannot give you is the depleted case: when every account is at the wall the session must be PAUSED until something resets, and a live `claude` cannot pause itself.

So the supervisor's job is narrow: on a depleted pool it **replaces the process at a salvageable moment** - after a turn completes, the conversation is fully written to the transcript JSONL and `claude` is idle at the prompt, so killing it there loses nothing - shows an interruptible countdown to the soonest reset, and relaunches `claude --resume <session-id>` when it passes. **Thresholds still sit below 100%: the headroom is the budget to reach a clean turn boundary (plus up to one turn of adoption lag on macOS) before the account actually hits the wall.** The session window screens on a ladder, a single rung at 90 by default; a configured ladder like 50 then 80 then 95 has each rung take over once every pooled account is past the one below (a 5h reset is cheap to sit out, so a multi-rung pool drains level by level), while the weekly windows drain to 98 (weekly allowance is use-it-or-lose-it).

A hook can't do the pause-and-relaunch - when `claude` exits, the shell owns the terminal. So tokenmaxxing installs a **supervisor** (aliased to `claude`) that owns the process lifecycle:

```
supervisor (you type `claude`)  →  real claude (inherited stdio)  →  Stop hook
        ▲_______________ relaunch --resume <sid> ______________|
```

It is a process manager only - spawn with inherited stdio plus saved `stty -g` termios (not a PTY copy), wait, restore the terminal, relaunch. It never proxies API traffic or handles tokens. Everything else about `claude` is unchanged.

---

## 2. What tokenmaxxing installs

- A `claude` **supervisor** on your PATH ahead of the real binary (`~/.config/tokenmaxxing/bin/claude`), or a shell function - you invoke it identically.
- Four `~/.claude/settings.json` entries (merged - other settings keys are preserved, but the `statusLine` slot is taken over): the tokenmaxxing `statusLine` renderer (native since 2026-07-11; it also tees usage), a `subagentStatusLine` (per-subagent rows in the agents panel), a `Stop` hook, a `SessionStart` hook.
- **`~/.config/tokenmaxxing/`** - the single home for config and state:
  - `config.json` - SPARSE overrides only (thresholds.session/weekly, claudeBin/codexBin pins, policy.*); defaults merge at read time, `xx config` edits it.
  - `accounts.json` - non-secret index `{email, organizationUuid, accountUuid, label, lastUsage, lastPerModel, needsReauth, ...}` (window resets live inside lastUsage).
  - `usage.json` - live usage, written by the statusLine shim.
  - `respawn/<session-id>` - per-session respawn markers (the hook→supervisor signal, depleted-pool waits only).
  - `bin/claude` - the supervisor.
- Per-account **credentials** follow the platform's Claude Code store: macOS = login-keychain items `tokenmaxxing-cred-<accountUuid[:8]>` (never plaintext on disk); Linux = 0600 files `creds/tokenmaxxing-cred-<accountUuid[:8]>.json` (the same plaintext model claude itself uses - its Linux build has no keyring path at all, binary-verified 2.1.205). One `credstore` facade dispatches on a `{kind: keychain|file}` target; call sites never branch on platform.

- A periodic check job (`com.tokenmaxxing.check` launchd agent on macOS, `tokenmaxxing-check.timer` systemd user timer on Linux) running `tokenmaxxing check --if-due` once per tick (`policy.checkIntervalMs`, 60s by default), self-paced up to five ticks from the live account's headroom: hooks alone miss long agentic turns, so the timer is the backstop that keeps switching engaged mid-turn.

The switching path runs no long-lived daemon. The statusline pushes usage. Hooks and the supervisor react. The periodic check job above is the only recurring process. The `claude` binary and `~/.claude` layout are untouched.

---

## 3. How a switch happens

### 3.1 Usage feed (free, push-based)
The Stop hook's stdin has no usage data, but the **statusLine does** (`rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`, after every turn, 300ms debounce, zero cost). tokenmaxxing's statusLine tees that to `usage.json` (write-on-change, O(ms)) and renders its own native line (it replaced the earlier pass-through delegation on 2026-07-11: install takes the statusLine slot outright, so a pre-existing custom statusline command is overwritten). Cold-start fallback if `usage.json` is absent: `TOKENMAXXING_PROBE=1 claude -p '/usage'`, with `[ -n "$TOKENMAXXING_PROBE" ] && exit 0` as the hook's first line to stop the nested process recursing (hooks fire in `-p` too). The probe scrubs every ambient credential override claude reads before the keychain (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, etc.) so it can only meter the credential in the keychain item, and retries the transient empty-footer case (claude prints local stats with no percentages when its own usage fetch throttles).

### 3.2 Detect + swap + signal (Stop hook, per turn)
1. Read `usage.json`; `exit 0` fast below the engagement floor (`policy.greedySessionFloor`, default 80% of the 5h window) unless a screening bar is already crossed. Engaged-but-under-every-bar runs the GREEDY convergence: stay when the current account wins or ties, else swap onto the strictly better account. A crossed bar forces the hard path (metered per `organizationUuid`).
2. Else take a `flock` on `~/.config/tokenmaxxing/lock`, re-check under it (parallel sessions race - first winner already swapped), pick the best parked account (not rate-limited, furthest behind its own weekly pace first: highest remaining% / time-to-weekly-reset, since unused allowance is forfeited at the fixed per-account reset; tiebreak soonest expiry then lowest 7-day usage), and **swap the credential** (§3.4).
3. Done - the running session adopts the new credential on its own within a request or two. Only when the pool is depleted (the decision returned a `waitUntil`: pre-parked on the soonest-recovering account, or staying on the current one when it recovers first) does the hook write `respawn/<session_id>` (atomic temp+rename).

### 3.3 Depleted-pool pause (supervisor)
The supervisor sees `respawn/<sid>`, SIGTERMs its child at the already-committed turn boundary, deletes the marker, resets the terminal, shows an interruptible countdown to the reset, and relaunches `claude --resume <sid>` when it passes. The resumed process reads the keychain cold → runs on the recovered account, same conversation. The `SessionStart` hook (source `resume`) re-checks the account before the first turn as a backstop.

### 3.4 Swap sequence (under the lock)
1. **Harvest the live credential into its TRUE owner's backup** - read the current `Claude Code-credentials` blob and resolve which account it actually belongs to via the roles endpoint (`GET /api/oauth/claude_cli/roles`), NOT the `accounts.json` active label. The label drifts from the live blob (a kill mid-swap, a manual `/login`), and harvesting by label once overwrote another account's backup and destroyed its only credential. Mandatory anyway: Claude rotates the refresh token in place, so older backups are dead. Refuse the swap if the live credential belongs to no pooled account.
2. **Refresh B** - OAuth refresh-grant with B's parked refresh token → fresh access token; persist the rotated refresh token. On `invalid_grant`, mark B `needs_reauth`, notify, try the next account.
3. **Install B** - `security add-generic-password -U ... 'Claude Code-credentials' ...` with B's fresh (non-expired) `claudeAiOauth` JSON.
4. **Swap identity + mark B active** - atomically rewrite only the `oauthAccount` object in `~/.claude.json` (temp+rename) to B's, and write `activeAccountUuid = B` in the SAME critical section, so a crash can't leave the installed credential and the active label pointing at different accounts.
5. Do steps 1, 3, 4 inside Claude's own refresh locks - the primary `<credDir>/.oauth_refresh.lock` plus the legacy sibling `<realpath(credDir)>.lock` (`~/.claude.lock` by default), both mkdir-based proper-lockfile locks, binary-verified against 2.1.214 - so the writes can't collide with a token refresh. Contention fails the swap fast (claude itself gives up with `lock_timeout` rather than refreshing unlocked); the next check retries.

### 3.5 Multiple concurrent sessions
Each terminal ran the supervisor, so each has its own child `claude` and its own `--session-id`. When the shared account hits a threshold, the first Stop hook to win the `flock` performs the one swap; every running session then adopts the new credential in place - no restarts. (They share one credential, so they always move together - consistent with "one current account, many windows.") Only a depleted pool fans out: each supervised session's Stop hook writes its own `respawn/<sid>` marker, and each supervisor independently pauses and later relaunches `claude --resume <its-own-sid>`.

---

## 4. Onboarding (no `adopt`)

- **`tokenmaxxing init` imports the account you're already on - automatically, no prompts, no re-login.** It reads the live `Claude Code-credentials` keychain blob plus the `oauthAccount` object in `~/.claude.json` (email, `organizationUuid`, `accountUuid`, plan tier) and writes them as **account #1** into tokenmaxxing's store (`tokenmaxxing-cred-<accountUuid[:8]>` + an `accounts.json` index entry). Nothing about your current session changes - that account stays active; it's now just also a registered pool member. After this one command you already have a working (single-account) pool. `init` also installs the supervisor + the four settings entries.
  - If the current auth is API-key mode (`ANTHROPIC_API_KEY`/`apiKeyHelper`) rather than a subscription `/login`, there's no quota-poolable subscription credential to import - `init` says so and points you to `/login` first (per-token API billing isn't what tokenmaxxing pools).
- **`tokenmaxxing add`** - registers *additional* accounts: logs one in via a throwaway `CLAUDE_CONFIG_DIR=~/.config/tokenmaxxing/onboard` (your primary login untouched), harvests it into the store, deletes the temp dir + its namespaced item. `CLAUDE_CONFIG_DIR` is SET by tokenmaxxing only for throwaway isolated stores like this one: the same harvest serves `auth`, and parked-account `/usage` sampling probes under `sample/<item>` the same way; an AMBIENT `CLAUDE_CONFIG_DIR` is refused by every CLI command and by the SDK's pooledSpawnEnv.
- **`tokenmaxxing auth [sel | --all]`** - reauthenticates an *existing* pool member whose refresh token died (a needs-reauth account can never heal through a swap: the dead token is exactly what a swap would need). Same isolated-login harvest as `add`, but it states which email to sign in with and **requires the login to land on the target account** (harvested `accountUuid` must match, else nothing changes) - the credential write and the needs-reauth clear happen in one flock critical section so a concurrent swap's harvest cannot clobber the fresh backup. Bare `auth` lists the pool with emails and asks which; `--all` walks every flagged account one by one.
- Both commands exercise `security` reads/writes interactively (where a macOS keychain ACL prompt is acceptable), so the first access never happens cold inside a headless hook.

---

## 5. Rotation policy
The decision engages at `five_hour >= 80%` (policy.greedySessionFloor): from there it greedily converges on the usable account furthest behind its weekly pace, staying put whenever the current account wins or ties. The automatic greedy path adds **incumbent hysteresis** (`policy.greedySwapMargin`, default 0.15): the seat holds unless a parked account's pace pressure beats it by more than that fraction, so near-tied accounts stop trading the seat back and forth and busting the per-org prompt cache (each such swap forces a full uncached re-read next turn). The margin only gates lateral under-bar swaps, never a crossed bar or the wall; bare `tokenmaxxing switch` sets it to zero and still converges on the strictly best account. The **Layer 1 screening bars** - `five_hour >= <active rung>` (the 5h ladder `thresholds.session`, default `[90]`, a single rung: the lowest rung some pooled account still clears, the current one included) OR `seven_day >= 98%`, per org (`thresholds`) - force a switch onto a fresher account and also screen candidates. "Exhausted" is a **timestamped state** (`resets_at`), not a flag - an account is a candidate again after it resets. Optional projected threshold (`bar - policy.projectionMargin`, a fixed configured margin) so a single large turn is less likely to blow past 100% before the next Stop hook.

**Two layers - pump the last drops.** The screening bars deliberately leave headroom, so when *every* account is over them Layer 1 alone would park the pool with 2-5% of each account's quota still unspent. **Layer 2 - the wall bars** (`hardThresholds`, default `100/100`, the server's own limit) - is the fallback reached only at that point: the session **holds its seat and squeezes** while it is under the wall, else swaps onto the best still-under-wall account (the same pace-pressure ranking as every other swap - squeeze the account whose weekly quota is most about to be forfeited first), and only parks (depleted-wait) once every account has truly walled. Recovery is then measured against the wall, not the screening bar, so an account whose 5h window drops below 100 is squeezable again even while its weekly window still sits above the Layer 1 bar. The wall reading is the statusLine's own `rate_limits` feed - the same server-side figure claude's `/rate-limit-options` renders - so when an account genuinely maxes out the tee shows 100 and Layer 2 moves on; a single-turn overshoot is caught one boundary later (the periodic `check` timer, or the next Stop hook) without needing to sniff assistant text. Set `hardThresholds` equal to `thresholds` to disable Layer 2. **Layer 2 is Claude-only:** a swap on Claude is a hot, in-place credential adoption every concurrent session follows automatically, whereas a running Codex refuses another account's credential (restart is the switch), so a last-drop-swap there would strand any sibling still on the walled account - Codex instead keeps riding its current account to the wall (its existing all-exhausted stay-put already squeezes it).

**Model-aware trigger.** Claude subscriptions also enforce **per-model weekly caps** - currently only for Sonnet and Fable (there is no Opus-only quota), and Fable's tighter limit binds *before* the aggregate (e.g. 80% week-Fable at only 50% week-all-models). This cap isn't in statusLine stdin, so when the active model is in `policy.switchModels` we read it from `claude -p '/usage'` (free, 0 tokens, TTL-cached) and add `week(<activeModel>) >= threshold` to the trigger. A Fable session switches on the Fable cap; a Sonnet session rides the aggregate. Both layers apply the per-model gate: a burnt Fable cap screens an account out of a Layer 1 switch, and a Fable cap at the wall screens it out of the Layer 2 squeeze too.

---

## 6. Honest papercuts
- **Respawn hiccup (depleted pause only).** Plain swaps never restart the session. When the whole pool is depleted you see `claude` stop, a countdown, and a resume; anything typed in the split second before the SIGTERM is lost, and the supervisor resets terminal mode so nothing is left garbled.
- **Adoption lag.** macOS reads the keychain through a raw 30s cache, so at most the first turn after a swap can still meter the old account. The bars' headroom absorbs it.
- **One cold turn.** Prompt cache is org-scoped: the first turn on B re-uploads context once (bigger on long transcripts).
- **Single-turn overshoot.** If one turn jumps from under the threshold straight past the wall, that turn can end rate-limited before the Stop hook swaps; the swap then still recovers the session (its next turn adopts the fresh account). Projected threshold reduces this.
- **Shared blast radius.** All default-profile sessions share one keychain item, so a swap moves them all (each adopts in place). The `flock` + re-check is mandatory or racing hooks burn two accounts at once.
- **Refresh-token rotation / parked-token rot.** Step 1 re-harvest is mandatory; a parked refresh token can be invalidated by logging in elsewhere → picker must catch `invalid_grant`, mark `needs_reauth`, fall through.
- **statusLine fragility.** The native statusline is the most visible surface - a bug flickers or blanks the line for every session (and install takes the slot outright, replacing any custom statusline you had). Keep it O(ms), write-on-change.
- **Keychain blob size & ps-safety.** The live `Claude Code-credentials` item also holds per-MCP-server OAuth state, so it can exceed `security -i`'s ~4KB interactive line buffer (verified on a real machine - a 4.3KB blob truncated). tokenmaxxing therefore stores parked backups as **`claudeAiOauth`-only** (small → always the ps-safe stdin write) and, on a swap, **merges** the fresh `claudeAiOauth` into the *current* live blob so MCP tokens survive the switch - using the argv write path (secret briefly visible in `ps` on your own machine) only for that one oversized live write.
- **settings.json is user-owned.** Install by merge; ship `tokenmaxxing doctor` to verify the supervisor + 4 entries survive a `/config` edit or update.

---

## 7. Scope
**v1:** `tokenmaxxing init` / `add` / `ls` / `status` / `doctor`; the supervisor; statusLine shim + Stop/SessionStart hooks; threshold swap with `flock` + reset-aware picker; platform credential store (macOS keychain / Linux 0600 files, one facade); auto-respawn across concurrent sessions. macOS + Linux.

**v2:** projected-threshold pre-emption; a `UserPromptSubmit` guard that respawns *before* a turn starts when already over; Windows.

**Shipped since (0.11.0):** a programmatic SDK surface (`src/sdk.ts`, the package's `exports["."]`) for pairing with the Claude Agent SDK - personal use across the owner's own pooled accounts. The Agent SDK reads credentials per subprocess spawn and has no statusLine, so the surface is boundary-driven: run the shared switch decision before a spawn (`ensureBestAccount`) and at Stop-hook turn boundaries (`stopHookCheck`), and hand the SDK a pinned real-claude path plus a full replacement env scrubbed of credential overrides (`pooledOptions`).

**Later:** tool-agnostic picker.

**Shipped since (0.13.0):** Codex as a second pool, parallel state (`codex-accounts.json`, `codex-creds/`, own flock), same pace-pressure policy. Codex differences that shaped it: restart IS the switch (a running codex refuses another account's credential), usage is a free direct GET with epoch resets and a duration-classified window set (the weekly window is primary on current plans), the refresh token rotates with reuse punished (harvest-by-true-owner, persist every rotation), and codex's new Stop-hook system drives the auto-swap through a codex supervisor shim that respawns `codex resume <session-id>` (hooks must be trusted once via `/hooks`). Sibling sessions left on ANY non-live account are reconciled cross-session (owner decisions 2026-07-20; a non-live session cannot refresh cross-account and would wedge at token expiry, healthy or not): the deciding actor drops a reconcile marker addressed to the sibling's supervisor, and the sibling's own Stop hook promotes it into a respawn onto the live account at its next turn boundary - the only safe respawn point - while a blocked live seat never receives a signal.

**Non-goals:** an API/MITM proxy; reimplementing OAuth beyond the single refresh-grant call in the swap; Slack as a message bus; soft concurrency caps.

---

## 8. Stack
TypeScript on Bun, shipped as source: one multi-call entry (`src/main.ts`, `#!/usr/bin/env bun`) serves the CLI, the `claude` supervisor, the statusLine shim, and the hooks; `init` installs a 2-line shim that `exec`s bun on the installed package's entry (the Stop path runs every turn; bun's start-up stays low-millisecond). Published to npm as `tokenmaxxing` (source, platform-independent - a compiled binary was tried and shipped one architecture's Mach-O to every platform). Shipping is PR-based since 2026-07-18: work reaches main only through a pull request (branch, PR, CI green, a 10-minute review wait, every review handled, merge, teardown), and a release is a PR-landed version bump followed by `gh release create` (details in AGENTS.md "Release and CI"). The supervisor spawns claude with inherited stdio and restores saved `stty -g` termios between runs - no PTY layer; resize and signals flow through the shared foreground process group.

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
