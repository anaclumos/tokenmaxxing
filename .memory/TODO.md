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

- [x] `gpt-reserve` row renders as `rsrv` (PR #56, merged c5374ce, v1.9.1 released, `npm view` shows 1.9.1)
- [x] Ladder: `thresholds.session` is an ascending list, default [50, 80, 95]; `effectiveBars(cfg, pool)` resolves the active rung per pool; codex on `terminalBars`
- [x] Cadence: per-stage ceiling on the check sleep (300/180/120/60)
- [x] Docs: configuration, switching, README, DESIGN, AGENTS; memory addendum
- [x] Owner ruling: delete all test code and comments from the codebase. `test/` and `bunfig.toml` trashed and unstaged, `test` script and publish-time test run dropped, CI test step dropped, tsconfig include narrowed to `src`, nix fileset no longer lists bunfig.toml, flake.nix comments removed, doc snippet comments turned into prose. AGENTS.md `## Testing` records the ruling.
- [ ] bun.nix generator header: decide whether to strip (regeneration re-adds it)
- [ ] Diet audit findings presented (ask before cutting)
- [ ] typecheck clean
- [ ] Adversarial review of the ladder diff
- [ ] PR opened, CI green, 10-minute window from the last push, every review handled
- [ ] Merge, `gh release create v1.10.0`, verify `npm view tokenmaxxing version` is 1.10.0, teardown
