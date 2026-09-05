# TODO

Dated 2026-08-30. Ship of StopFailure force-switch + dynamic check cadence + comment strip (branch feat/stopfailure-dynamic-check).

- [x] Diagnose the Fable switch (probe fail-silence, no StopFailure hook)
- [x] StopFailure hook: classify, stamp, force, retrigger marker
- [x] Dynamic check cadence (60s floor tick, 60-300s self-paced)
- [x] Delete every code comment (owner ruling 2026-08-30)
- [x] Test suite green with the new tests (379 pass, 1 skip, 0 fail after the plugin.json version fix)
- [x] Docs: switching, state directory, limitations
- [x] AGENTS.md and .memory updates
- [x] Bump to 1.9.0
- [x] Review the diff: three finders ran; the refuter panel was killed mid-run (owner: "Don't spam fable like that", recorded in fable-fanout-is-quota-spend.md); findings verified by hand instead
- [x] Fix the eight confirmed findings (resolved reset carried into the enforcement, unmeasured-account pin, anticipatory only with an enforcement, proof anchored on the error row, tick-start due anchoring with half-tick slack, bare `check` unconditional with `--if-due` for the timer, systemd AccuracySec 5, quickstart cadence text); two refuted (marker gate has both arms, dismissed-countdown suppression is by design)
- [x] Edited test files green (41 pass), tsc clean
- [x] swap-concurrency e2e after the fixes: ALL PASS
- [x] Full suite after the fixes: the one flake was my own new tick-anchor assertion (1ms clock skew), replaced by a slow-probe anchoring test; then 384 pass, 1 skip, 0 fail on two consecutive full runs, tsc clean
- [x] Commit the review fixes by explicit path
- [x] PR #55 opened (branch pushed 2026-08-30 11:16:13Z; review window runs the full 10 minutes from the last push)
- [x] CI green on #55 (test, nix)
- [x] First review window elapsed 11:26:13Z; one Codex P1 (premature "shipped in 1.9.0" claim in stopfailure-enforced-limit-signal.md) fixed; the fix push restarts the 10-minute window
- [x] Second review window elapsed, every review handled (merged as ae8d41d, per git history)
- [x] Merge #55 (ae8d41d)
- [x] `gh release create v1.9.0` (tag v1.9.0 exists)
- [x] Teardown: branch cleanup, TODO closed

Dated 2026-09-02. Codex reserve label (1.9.1) and the 5h session ladder (1.10.0).

Goal: ship 1.10.0, a 5-hour threshold ladder (50, then 80, then 95, with the check cadence tightening one band per rung) that drains the pooled accounts level by level, in a repo that carries no tests and no comments and whose every doc page states the thresholds the code enforces.

Longer form: tokenmaxxing drains a pool of the owner's own Claude and Codex accounts evenly and without the owner noticing. The 5-hour window is a ladder, not a single bar: a seat hands off at 50 while any sibling is under 50, the bar climbs to 80 once every account is past 50, then to 95, and the check cadence tightens per rung so a fuller pool is watched more closely. Verification is the typecheck plus hermetic runs of the real CLI. Done means merged, released, visible on npm, and English plus localized docs in agreement with the code.

Diet audit candidates (owner picks; none applied):
1. Eight copies of the parse-JSON-then-safeParse idiom: one zod pipe from a JSON text codec into each schema.
2. Five identical stdin readers: `Bun.stdin.text()`.
3. Hand timer plus race around the usage probe spawn: the spawn's own `timeout` and `killSignal`.
4. Probe retry loop: es-toolkit `retry` once the single probe throws instead of returning null.
5. Hand-merged config defaults in the loader: schema defaults.
6. Shell quoting of the hook command through `JSON.stringify`: `Bun.$.escape` (changes how installed hooks are recognized on live hosts).
7. Manual tail read of the transcript: a `Bun.file` slice.
8. Duplicated guards across entries (ambient store check, launch timestamp parse, truecolor detection, depth cap block): one shared site each.

- [x] `gpt-reserve` row renders as `rsrv` (PR #56, merged c5374ce, v1.9.1 released, `npm view` shows 1.9.1)
- [x] Ladder: `thresholds.session` is an ascending list, default [50, 80, 95]; `effectiveBars(cfg, pool)` resolves the active rung per pool; codex on `terminalBars`
- [x] Cadence: per-stage ceiling on the check sleep (300/180/120/60)
- [x] Docs: configuration, switching, README, DESIGN, AGENTS; memory addendum
- [x] Owner ruling: delete all test code and comments from the codebase. `test/` and `bunfig.toml` trashed and their deletion committed, `test` script and publish-time test run dropped, CI test step dropped, tsconfig include narrowed to `src`, nix fileset no longer lists bunfig.toml, flake.nix comments removed, doc snippet comments turned into prose. AGENTS.md `## Testing` records the ruling.
- [x] bun.nix generator header stripped (regeneration via `bun run nix:bun` re-adds it; owner decides then)
- [x] pullfrog workflow removed (owner: "Remove pullfrog too")
- [x] typecheck clean; four hermetic `check` scenarios under a throwaway root behave as specified (hand-off at 50 over a pace-winning seat, greedy hold at 80, hand-off at 95, wall hold past 95); live `status` header reads `5h 50/80/95% (at 50%)`
- [x] Adversarial review of the branch: 12 findings survived, 8 refuted. Fixes committed as d3273bc: the hard path reloads the pool after a dead grant and returns to the greedy path when the rung climbs over the seat, chooseAndSwap takes a plain PickCtx again, the status header resolves the rung with the engine's gated families, README/quickstart/distribution fence comments became prose, the publish gate no longer claims a test suite, the safe-contribution and switching-policy skills carry the ladder vocabulary
- [x] Paused 2026-09-02 on the owner's "Hold all and pause"; resumed the same day on "Continue from feat/session-threshold-ladder"
- [x] Owner approved the hermetic swap harness (throwaway state root, keychain items under a random account name deleted at the end with the leftover count printed, stubbed OAuth token and roles endpoints). Procedure and scenario table: hermetic-ladder-verification.md
- [x] Hermetic run 1: greedy hold at 80, wall hold past 95, rung-1 slow lane, the custom ladder [20, 80, 95] with the stage cap binding, and ten config validation cases all PASS. The four swap scenarios (hand-off at 50 over a pace-winning seat, hand-off at 95, dead grant climbs the rung, dead sibling then swap to the next) did not run: the stub server lived in the harness process and Bun.spawnSync blocked its event loop, so the token endpoint timed out. Fix is a separate stub process or an async spawn, then a re-run.
- [x] Locale sweep launched: one agent per locale, 29 locales, seven pages each (configuration, switching, sdk, quickstart, distribution, architecture, platforms), diff-driven against the English pages, keeping already-correct translated units verbatim. Drift found beyond the ladder: every locale lacked the 1.9.0 Enforced limits and Check cadence sections and still stated a 180 second timer and three settings.json entries. Snapshot committed as 148433e with 27 locales complete and am, mr mid-flight.
- [x] A second session on the owner's Mac resumed the same pause from the local working tree (which still held the review fixes uncommitted and no knowledge of the salvage push) on `/goal finish TODO.md` and "resume". It re-ran the four `check` scenarios on the fixed tree with the simpler throwaway-root method (hand-off proven by the swap reaching for the sibling's parked credential on a throwaway keychain namespace): hand-off at 50 over a pace-winning seat, greedy hold at 80 with the next check in 180s, hand-off at 95, wall hold at 96/97 with the next check in 60s. It committed the same review fixes as 509c0dc (byte-identical code, English docs, README, skills, and package.json to d3273bc), then a five-page locale sweep as 116ae60 (one opus writer per locale, a mechanical gate, one opus reviewer per locale, 21 locales with findings fixed and re-verified in 20; the owner waived the am re-review with "skip review"), with every staged diff read in full before each commit.
- [x] Collision found at push time: the remote branch carried d3273bc, 148433e, accf49a, and 64f5baa. Owner ruling 2026-09-02: merge the remote line in (no rebase, no force), take the remote's localized pages wholesale, keep the identical code. Done as a merge commit; the docs tree equals the remote's byte for byte and 116ae60 stays in history, superseded.
- [x] Owner rulings during the resume: "skip review" and "no need to focus on docs. focus on features". The per-locale adversarial verification of the seven-page sweep is waived under those rulings. The full untruncated read applied to every commit this session authored; the merge commit takes the remote's already-pushed docs tree unchanged, gated mechanically instead of read line by line, a deviation from pre-commit-full-diff-inspection.md taken on the owner's instruction.
- [x] Mechanical gates on the remote's locale files, run read-only on the remote tree before the merge: no stale `"session": 95`, `# or`, `# ...`, or sdk fence comments across the 145 five-page files; `^## ` count is 9 in all 29 switching.*.mdx; 1 em-dash left across those 145 files; code fences differ from English in 35 files, by the trailing translated `#` comments on shell lines and the distribution nix profile fence.
- [x] `cd docs && bun run build` on the merged tree: exit 0, 510 static paths
- [x] Owner ruling: build and run the dead-grant harness before the merge. Stub OAuth server out of process (token and roles endpoints through the `TOKENMAXXING_OAUTH_*_URL` overrides), keychain items under a random account name, deleted afterwards with the leftover lookup exiting 44. Both scenarios PASS: dead grant climbs the rung (B stamped needs-reauth, rung climbs 50 to 80, seat A at 55 holds on the greedy path, next check in 180s, live account unchanged) and dead sibling then swap to the next (B stamped, A harvested, live moves to C, next check in 45s). Procedure: hermetic-ladder-verification.md. All eight scenarios and the config cases are now covered between the two sessions.
- [x] Merge committed as 97d9e1d and pushed 2026-09-02 12:04:42Z; PR #57 opened at once (review window runs the full 10 minutes from the last push)
- [x] Review round 1 on #57: Codex completed with no findings; cubic posted 7. Five fixed in b817326 (bare `switch` gates by the live model like the engine, the safe-contribution skill names TOKENMAXXING_CLAUDE_JSON, the switch-policy memory names barsOf instead of a ctx factory, fr register, pt variant); two refuted on the threads (the wuu entry count and the zh cadence summary both mirror the English source). Pushed 2026-09-02 13:29:36Z; the window restarts from there.
- [x] Memory push 06db89a at 13:32:12Z (harness procedure, review round 1 record); CI green (test, nix, Vercel, cubic); Codex re-reviewed it at 13:36Z with no findings; cubic posted nothing new; the two refuted threads stand (the wuu count mirrors the English "four entries ... (plus a subagentStatusLine entry)" wording). Window elapsed 13:42:12Z.
- [x] Merged #57 as 19df8b8 (2026-09-02 13:43:33Z); `gh release create v1.10.0` published 13:44:19Z; the release run's publish job succeeded; `npm view tokenmaxxing version` and `dist-tags.latest` both read 1.10.0
- [x] Teardown: remote and local `feat/session-threshold-ladder` deleted, harness and throwaway decision roots trashed, no stub process left, keychain namespace verified empty earlier. These memory ticks land with the next PR (no direct push to main).
- [x] Diet audit: the eight candidates above are presented to the owner in the ship report; none applied (owner rule: present findings, ask before fixing). Any pick is new work, not part of this goal.

One-line goal for the resuming machine: Ship tokenmaxxing 1.10.0 from branch feat/session-threshold-ladder (5h ladder 50/80/95, check cadence capped one band per rung, no tests, no comments) with every English and localized doc page stating exactly what the code enforces: finish the locale gates and verification, re-run the hermetic harness, open the PR, pass CI, sit the full 10-minute review window, merge, release v1.10.0, verify npm.

Dated 2026-09-05. `--json` output mode (1.11.0), branch feat/json-output, PR #58.

Goal: every reporting command prints one JSON document on stdout under `--json` (`ok` mirrors exit 0, failures add `error`, progress stays on stderr, never credential material), with the text form byte-identical to 1.10.0 apart from the new `--json` help line (two further deltas accepted in review round 1: the `config unset` known-keys hint and the Codex greedy switch reporting a dead grant on stderr), then ship it PR-based with the release and the npm publish verified.

- [x] Flag parse in `src/main.ts` after the supervisor pass-through (claude/codex argv never filtered); `init`/`add`/`auth` refuse with exit 2
- [x] `emitJson`/`emitError` in `src/cli/render.ts`; every error branch of status, ls, config, doctor, check, switch, switch --codex, watch, rename, rm, uninstall routed through them
- [x] `status` split into collect (typed report) and render; text diffed against main on a throwaway root (identical) and on the real pool via the free `/usage` path (only probe-timing tie order differs)
- [x] Docs: commands.mdx row + "JSON output" section, README row, help text, pool-status skill; `cd docs && bun run build` exit 0
- [x] Bump 1.11.0 in package.json and agent-plugin/plugin.json; typecheck clean
- [x] Committed 673b5a8 by explicit path after the full untruncated diff read; pushed; PR #58 opened 2026-09-05 06:42:20Z (window runs 10 minutes from the last push)
- [x] Adversarial review of the branch: four opus finders ran; the refuter stage was STOPPED early because one finder ran `uninstall --json` under a throwaway `TOKENMAXXING_HOME` on the dev host and stripped that host's live install (settings.json entries, codex hooks.json, rc PATH line, systemd timer; wrappers, accounts, and credentials untouched). No repair attempted: `init` on a live host is the owner's step. Lesson recorded in AGENTS.md. Findings triaged by hand: fixed the status render/sample interleaving, the `ls` codex-read ordering, the `--force` ping-note gate, the codex no-target stdout routing, the `swapTo` dead-grant record, the guard order for the interactive refusal, the doctor `error` field and raw rc line, the not-due `nextCheckAt`, the codex-only `watch`, and every undocumented field; refuted the JSON `notes`, the stale-window zeroing (unmeasured must never look safe), the `config unset` hint (intended consistency), and the locale sweep (owner: features over docs)
- [x] Codex review round 1 (4 findings, all fixed) and cubic round 1 (13 findings: 9 fixed, 3 refuted, 1 duplicate) handled in the same push
- [ ] CI green, review window elapsed from the last push, every reviewer finding handled
- [ ] Merge, `gh release create v1.11.0`, `npm view tokenmaxxing version` reads 1.11.0
- [ ] Teardown: remote and local branch deleted, throwaway roots removed

One-line goal for the resuming machine: Ship tokenmaxxing 1.11.0 from branch feat/json-output (PR #58, the `--json` output mode): finish the adversarial review, pass CI, sit the full 10-minute window from the last push, handle every review, merge, release v1.11.0, verify npm, tear down.
