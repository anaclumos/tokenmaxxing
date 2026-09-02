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
- [ ] Hermetic harness scenarios still unrun end to end: dead grant climbs the rung, dead sibling then swap to the next (need the stub OAuth server out of process, see hermetic-ladder-verification.md). The other six scenarios and the config cases are covered between the two sessions' runs.
- [ ] Ship: PR body drafted (scratch pr-body-1.10.0.md in the second session; rewrite the localized-docs line for the seven-page sweep), push the merged branch, open the PR, CI green, 10-minute window from the last push, handle reviews, merge, `gh release create v1.10.0`, `npm view tokenmaxxing version` shows 1.10.0, teardown
- [ ] Diet audit: findings drafted from the stack map and two inventories; not applied (owner rule: present findings, ask before fixing)

One-line goal for the resuming machine: Ship tokenmaxxing 1.10.0 from branch feat/session-threshold-ladder (5h ladder 50/80/95, check cadence capped one band per rung, no tests, no comments) with every English and localized doc page stating exactly what the code enforces: finish the locale gates and verification, re-run the hermetic harness, open the PR, pass CI, sit the full 10-minute review window, merge, release v1.10.0, verify npm.
