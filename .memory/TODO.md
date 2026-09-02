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
- [x] Adversarial review of the branch: 12 findings survived, 8 refuted. Fixed: hard path returns to the greedy path when a dead grant climbs the rung under the seat (decide.ts loop, chooseAndSwap signature restored); status header resolves the rung with the engine's gated families; README nix-fence comments and switching prose; quickstart and distribution fence comments and the "full test suite" claim; safe-contribution and switching-policy skills plus references/policy.md; this file's wording
- [x] Paused 2026-09-02 on the owner's "Hold all and pause" at 4bd642b plus the uncommitted fixes. Resumed the same day on the owner's `/goal finish TODO.md` and "resume".
- [x] The four hermetic `check` scenarios re-run on the fixed tree before committing: hand-off at 50 (the swap reaches for the sibling's parked credential), greedy hold at 80 with next check in 180s, hand-off at 95, wall hold at 96/97 with next check in 60s. tsc clean.
- [x] Review fixes committed by explicit path as 509c0dc (signed)
- [x] Locale sweep committed as 116ae60: 29 localized configuration, sdk, switching, distribution, and quickstart pages brought in line with the English pages (ladder, comment-free fences, no test-suite claim). One writer per locale on opus, a mechanical gate (every fence byte-identical to English, em-dash counts and frontmatter unchanged against HEAD, docs site builds with 510 static paths), then a separate reviewer per locale; 21 locales drew findings, all fixed, and the fixes were re-verified in 20 of them (the owner waived the am re-review with "skip review"). Semicolons that mirror the English source were left in place; the English sdk and switching pages on this branch carry two such joiners themselves.
- [ ] Localized docs catch-up, found during the sweep and NOT in this ship (owner picks): all 29 localized switching pages never received the Enforced limits and Check cadence sections the English page gained in 1.9.0; most localized quickstart pages still list three settings.json entries and a fixed 180-second `tokenmaxxing check`; most localized distribution pages lack the English `nix profile install` sample and its surrounding text. Each is pre-existing drift, unchanged by the sweep.
- [ ] Diet audit: eight candidates listed above, presented to the owner; none applied until the owner picks (owner rule: present findings, ask before fixing)
- [ ] Ship: push, PR with the drafted body (scratch pr-body-1.10.0.md), CI green, 10-minute window from the last push, handle reviews, merge, `gh release create v1.10.0`, verify `npm view tokenmaxxing version`, teardown
