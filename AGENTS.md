# Agent rules

Repo-specific rules only. The owner's global rules load alongside this file in every session, so nothing here repeats them; where this file is silent, the global rule applies. Long-form detail lives in `DESIGN.md`, `docs/content/docs/`, `.memory/`, and in comments at the code site that could regress. Link to it, do not inline it.

## The project

tokenmaxxing pools the owner's own Claude Code and Codex logins, swaps to a fresher account as one nears its 5-hour or weekly limit, and keeps sessions continuable across swaps. Design: `DESIGN.md`. User docs: `docs/content/docs/`.

No external installed user base, so this is pre-production code: delete old-state compatibility rather than carry it forward.

## Safeguards and machine gotchas

- The owner's Mac runs tokenmaxxing straight from this working tree, so a bad git operation breaks the live install.
- This machine runs live supervisors, hooks, the periodic check, and the owner's real claude sessions. Stop processes by PID, and never kill a running session or supervisor to free a resource without asking.
- Never print credential material: keychain blobs, `.credentials.json`, `auth.json`, OAuth access or refresh tokens. Report account labels and status only. A ky error carries its request, Authorization header included.
- Ask before any run that meters real quota or opens a session window (`status --force`, live-pool runs). Free `/usage` reads are fine.
- This repo is PUBLIC. The no-Slack-info and no-device-info rule covers PR bodies, commit messages, review replies, release notes, and docs, not just `.memory`.
- `rm` is aliased to `rm -i` on the owner's Mac. In a non-TTY shell the prompt gets EOF, nothing is deleted, and it still exits 0, so `rm f && echo ok` lies. Deletion is the owner's call except for artifacts this session created; when you must, pass `-f` and verify the path is gone.
- macOS has no `/bin/true`. Use `/usr/bin/true` in tests.
- Env overrides parse through zod at the read site rather than a central `env.ts`, because the CLI's knobs are all optional. Unset parses to undefined and the feature degrades there.
- State files that exist but fail to parse THROW. A truncated `accounts.json` read as an empty pool once let `init` overwrite it.
- A configured-but-missing path (`claudeBin`, `codexBin`, credential locations) fails fast. Never fall through to a PATH scan: seeding `/bin/true` as claudeBin made the scan resolve the real installed wrapper and wedge an E2E for 15 minutes, the same shape that fed the runaway-recursion incident.
- The Mac runs the working tree, the Linux boxes run an npm global that nothing auto-updates, so version skew is chronic. For any works-on-Mac-not-Linux report, compare the box's installed version against the repo before anything else.
- Core deps are exactly zod, es-toolkit, and ky. The global default stack does not apply (there is no date-fns here, date math goes through `Intl` in `parseResetClock`).
- Keep `node:fs`, which is Bun-native. `Bun.file`/`Bun.write` are async-only, non-atomic, and have no create-mode, so they cannot serve the 0600 credential store or the flock fd. When asked to simplify this, that is the answer.

## Credentials and identity

- Identity is whatever `fetchTokenOrg` reports, never a stored label and never a blob comparison. Two rotations of one account's token differ byte-for-byte. Park a credential under its token's real owner, and commit the active label inside the same critical section as the credential writes.
- Every live-store write goes through `withClaudeRefreshLock`. A near-expiry session can rotate its own token into the live store at any moment.
- An ambient `CLAUDE_CONFIG_DIR` or `CLAUDE_SECURESTORAGE_CONFIG_DIR` is refused, in CLI commands and in `pooledSpawnEnv` alike: on Linux the swap would write where the ambient var points while the child reads the default store, a silent wrong-account desync.
- A missing namespaced keychain item never falls back to the live one, so isolation is sound once the probe env is scrubbed.
- The same accounts are pooled on several hosts with no cross-host lock, so two hosts refreshing one account race: on Claude that surfaces as needs-reauth churn, on Codex it kills the grant family. Documented, not engineered around (`docs/limitations.mdx`).

## Switching

Accounts rank by pace pressure (remaining percent over time to weekly reset, highest first), not by most-remaining. Mechanics live in `src/lib/decide.ts` and `src/lib/picker.ts` with rationale inline; policy in `docs/switching.mdx` and `.memory/switch-policy-pace-pressure.md`. The vocabulary below is used across both files.

- Engaged but under every bar = the GREEDY path: `currentWins` keeps the seat on best-or-tie, else swap onto the strictly better account. It never depleted-waits or pre-parks. Only the HARD path (a bar crossed) may.
- Layer 2 is the fallback reached only when the hard path finds no usable target, judged against the wall (`hardBars` = hardThresholds minus projectionMargin). A seat under its wall HOLDS and squeezes in place, and that check runs BEFORE any swap, or equally-squeezable siblings ping-pong. A walled seat swaps onto the best under-wall account.
- Layer 2 is CLAUDE-ONLY. A codex last-drop-swap would strand siblings on the walled account, because codex cannot hot-adopt and the reconcile only signals siblings onto a Layer-1-usable seat. Codex rides its account to the wall instead. Do not extend it.
- Build EVERY PickCtx and trigger floor from `effectiveBars(cfg)`: one bar per window for trigger and screening alike, or a margin-triggered swap lands inside the band and ping-pongs on the cooldown beat.
- Match model names by family substring or prefix, never by exact display string. Display names drift per release in BOTH directions ("Opus 4.8", and "Fable" became "Fable 5" in 2.1.206), so any exact-match gate silently stops matching. One did, and an account's Opus weekly drained to 100% with no auto-switch.
- Unmeasured must never look safe: an unmeasured usage percent renders as unknown, never 0, and ranks last, never first.
- Per-model weekly caps exist only for Sonnet and Fable, and only Fable gates a switch (owner, 2026-07-12).

## Claude internals

Verified auth and quota mechanics live in `.memory/cc-codex-auth-mechanics.md`; the credential store and swap sequence are in `DESIGN.md` §2-3. Both CLIs change monthly, so re-verify before trusting a recorded fact.

- Quota comes from `claude -p '/usage'` (free, 0 tokens), probed in a throwaway `CLAUDE_CONFIG_DIR` for parked accounts. The direct `GET /api/oauth/usage` was tried and REJECTED by the owner because it 429s when the sampled account is the one running the session: fix the CLI method, never bypass it. Codex deliberately differs here (its own direct GET was separately approved), so the codex side is not a precedent.
- Never probe the active account's own token. `/usage` is fail-silent for it and prints no percentages at all, so sample the active account from the statusLine tee instead.
- `claude setup-token` was investigated and abandoned: it is inference-only scoped and returns no rate-limit percentages, which breaks monitoring. Do not revisit without solving usage.
- Every new spawn of the real claude goes through `resolveRealClaude()`. Preset the depth cap for probe subtrees that must never re-enter the wrapper; set `TOKENMAXXING_UNMANAGED` where nested invocations are legitimate. The layered guards live in `src/lib/claudebin.ts`; read them there before adding a spawn.

## Codex

Source-verified against rust-v0.144.5 (2026-07-16); the installed CLI is 0.145.0 and codex changes monthly, so re-verify before trusting any line here. Detail: `docs/codex.mdx`, `.memory/cc-codex-auth-mechanics.md`, and the `src/lib/codex*.ts` headers.

- No hot-swap: restart IS the switch (`codex resume <sid>`).
- Refresh-token reuse is punished, and a superseded token kills the whole grant family. Harvest by true owner and persist every rotation the instant it returns.
- An idle codex still touches tokens: the Apps surface builds throwaway auth managers and can rotate `auth.json` outside our flock. Read the live blob at the last moment.
- An account running in another supervised session is never a swap target and never sampler-refreshed. Parked does not imply not running.
- Classify windows by DURATION, never by position. Current plans may have no 5h window at all.
- Codex silently skips untrusted hooks until the user runs `/hooks`, so auto-switching never engages until they do. Never clobber the user's `notify` key in `config.toml`; nothing in code guards it.
- `~/.codex/hooks.json` is not the only hook config source: a plugin manifest can point at its own via a `hooks` path key (verified in the 0.145.0 binary). tokenmaxxing only ever writes hooks.json, so check for other sources before assuming precedence.
- Codex Stop stdin carries `session_id`, `turn_id`, `transcript_path`, `stop_hook_active`, and `last_assistant_message` (all verified in the 0.145.0 binary), but no error signal, so the reverted text-sniffing failsafe below applies here too. `CodexStopStdinSchema` is a loose object declaring only `session_id` and `hook_event_name`, so it silently swallows the rest.

## Release and CI

Ship = work on a branch, bump `package.json` in the same PR, open the PR, make CI pass, wait out the review window, handle every review (fix, or refute with reasons), merge, `gh release create v<version>`, verify the npm publish landed, then tear down. A merge without a publish is not shipped. This repo merges its own PRs, which overrides the global "open the PR and stop". Detail: `.memory/shipping-pr-based.md`.

- Never push work directly to main.
- The 10-minute review window is a fixed timer from the last push. It always runs its full length; green checks never shorten it, because reviewers post findings after their checks pass.
- npm trusted publishing is bound to the literal workflow filename `ci.yml`. Renaming it silently breaks publishing.
- `bun add -g <local .tgz>` over an existing global errors `DependencyLoop`. Run `bun remove -g` first.

## Statusline and SDK

Short pointers; these surfaces document themselves at the code site.

- Statusline: `src/entries/statusline.ts` renders natively and tees `usage.json`; subagent rows in `src/entries/subagentstatusline.ts`. Format spec in `docs/statusline.mdx`. statusLine stdin sends top-level sub-objects as JSON `null`, so their schemas need `.nullable().optional()`, not `.optional()`. The main payload can never reflect the focused subagent; the subagent rows are the only such surface. This runs every turn, so keep it O(ms) and off flock and oauth: read the HEAD file, never spawn a git subprocess.
- SDK: `src/sdk.ts` is the programmatic entry and is self-documenting. `docs/sdk.mdx`, `.memory/agent-sdk-auth-surface.md`. Pooling subscription logins is framed as the owner using their own accounts in agents they run themselves; offering it to third parties is a ToS problem (`docs/terms.mdx`).

## Do not reintroduce

- A Stop-hook text-sniffing limit failsafe. Stop stdin carries no `is_error`, so it fired on turns that merely discussed limits and stamped healthy accounts as walled. It needs a real errored-turn signal first.
- Statusline formats already rejected: meter glyphs, Unicode fractions, dim or faint ANSI anywhere, account names, S/W window labels, percent signs, remaining-instead-of-used, usage numbers in color mode, and the counted parked collapse.
- Compatibility bridges, migration shims, or dual behavior for old local states.

## Testing

`bun test/e2e/swap-concurrency.ts` is standalone, not part of `bun test`, and has rotted silently once. Re-run it by hand after any decision-path change. New tests go inside `bun test`.

The live interactive-PTY SIGTERM test is still owed (`DESIGN.md` §9), but the owner declined it once. Never re-run it without asking.

## Lessons that cost something

- Verify an external tool's limits with a real-sized payload before relying on it. A 4.3KB credential blob truncated silently through `security -i`.
- A prior go-ahead does not cover collision evidence that arrives after it. Every new signal of concurrent work freezes git actions until the owner rules.
- Never write a completion claim into docs or memory ahead of the output that proves it.
- `status --force` opens a real 5h window on every account it pings. A feature request is not permission to spend.

## Cursor Cloud specific instructions

The cloud VM is a throwaway Linux clone, not the owner's Mac, so its git-safety and live-process cautions do not apply here; the machine-gotchas above still describe real runtime behavior.

- Runtime is Bun, which is not on the base image. The startup update script installs it to `~/.bun/bin` (added to `~/.bashrc`). A fresh non-login shell may not have it on PATH: run `export PATH="$HOME/.bun/bin:$PATH"` or call `~/.bun/bin/bun` directly.
- No Claude/Codex subscription logins exist here and none should be created, so the live swap loop, `init`, `add`, `auth`, and `status` cannot run end to end. Exercise the real decision engine hermetically instead: `bun test` plus the standalone `bun test/e2e/swap-concurrency.ts` (see `## Testing`). On Linux the 4 macOS-keychain tests skip, which is expected.
- For manual CLI pokes that must not touch real state, point `TOKENMAXXING_HOME` at a throwaway dir (e.g. `TOKENMAXXING_HOME=/tmp/xx bun run src/main.ts config`); it overrides the whole `~/.config/tokenmaxxing` state root. Commands that only read/write local state (`help`, `config get|set|unset`, `ls`, `doctor`) work with no accounts; `doctor` exits 1 on a fresh dir because nothing is installed, which is correct.
- The docs site under `docs/` is a separate Next.js app with its own `bun.lock`; the root update script does not install it. Run `cd docs && bun install` then `bun run dev` (serves http://localhost:3000). First page load compiles via Turbopack and can take ~20s.
