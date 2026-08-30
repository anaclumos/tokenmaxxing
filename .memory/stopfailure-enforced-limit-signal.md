---
name: stopfailure-enforced-limit-signal
description: The StopFailure hook (Claude Code 2.1.251) is the real errored-turn signal; classification is structured-only (hook ruling 2026-08-30, even the client's error text is prose); the live Fable cap is blind because the live-token /usage probe is fail-silent under load; the check timer is a 60s floor tick self-paced 60 to 300s
metadata:
  type: project
---

Dated 2026-08-30. Shipped in 1.9.0.

**Diagnosis of "fable switch not working".** Model-name matching was fine. The live account's Fable per-model cap has one source, `claude -p '/usage'` against the busy live token, and under session load it prints header-only or footer-only output: the log held 10,198 failed probes with 10-hour stretches of zero samples. A missing cap read as safe, every swap deleted `model-usage.json`, and the anti-storm stamp carried stale rows, so the 98 bar was jumped and ridden to 100. When the server enforced the limit, nothing ran: Claude Code fires `StopFailure` instead of `Stop` on an API-error turn, and no such hook was installed.

**StopFailure facts (bundle-verified 2.1.251).** Fires instead of Stop, for subagents too (`agent_id` set, same event name). stdin: base fields plus `error` enum (`rate_limit`, `overloaded`, `authentication_failed`, ...), `error_details`, `last_assistant_message`. Matcher is an exact match on the error kind. Fire-and-forget; exit code ignored. `quotaLimits` (`rateLimitType` in {five_hour, seven_day, seven_day_opus, seven_day_sonnet, seven_day_overage_included, overage}, `resetsAt` epoch seconds) lives only on the transcript row (`isApiErrorMessage: true`, `apiErrorStatus: 429`, `message.model: "<synthetic>"`). The Fable cap failure is the credits branch: no `quotaLimits`, no reset anywhere, `errorDetails` = `429 {json}` whose body is `error.type: "rate_limit_error"` (with `error.details.error_code: "credits_required"` for the credits variant); the client gates that branch on the request model being Fable. High-load strings carry no `errorDetails`; the generic transient 429 sets `apiErrorIsTransient`. The statusline payload no longer carries `organizationUuid`.

**Classifier rule (hook correction 2026-08-30, source: the repo's PostToolBatch hook).** The first cut classified the credits branch from the error rendering's tokens ("Fable" + "limit"). The hook ruled that the client's error text is still prose and only structured fields may classify. Now: `quotaLimits` names the window; otherwise a non-transient row with a `rate_limit_error` body is the credits branch, mapped to the credits-gated family (`fable`) only when it is a switch family. `last_assistant_message` is used only to pair the row with this failure (content identity), never for meaning.

**Post-swap proof.** A failure may stamp and force only when it provably ran on the post-swap credential: the hook's process launched after the swap (`TOKENMAXXING_LAUNCHED_AT`, set by the supervisor per launch), the turn started after the swap plus the cooldown, or with no anchor the cooldown alone. This is what lets one retrigger chain cross several burnt accounts; a naive 45s guard dead-ended at hop two.

**Decision integration.** `evaluateAndMaybeSwap(now, anticipatory, enforced)`: the enforcement bypasses the cooldown, forces the hard path, adds its family to `switchFamilies`, skips the Layer-2 seat hold, and clamps the seat's recovery to the enforced reset. Stamps: model rows get a real reset (server, else the family's known row, else the weekly reset) so a null reset never benches an account a full week; session/weekly stamps carry the other window from the tee or `account.lastUsage`. Subagent failures stamp and swap but never respawn or pre-park. The retrigger marker carries a one-shot prompt submitted behind `--` on the relaunch; the supervisor drops markers from a replaced launch and markers replaying a wait the user Ctrl-C'd out of.

**Check cadence.** `CHECK_INTERVAL_S` 180 to 60 (launchd, systemd, nix option). `check` gates on `nextcheck.json` (absent, corrupt, or far-future means due now; any swap clears it): headroom >= 40 sleeps 300s, >= 20 180s, >= 8 120s, else 60s; stale or foreign tee 180s; a gated family with no cap row never above 120s; a depleted wait sleeps toward its reset. The slow lane is safe only because the hook catches enforcement.

**Policy left alone.** `thresholds.weekly` stays 98 for the Fable cap and the greedy ranking ignores per-model caps below the bar, so an account at Fable 93 is a legitimate target while running Fable. Codex gets none of this (no error signal in codex hook stdin as of 0.150.1).

**Comments.** Owner ruling 2026-08-30: no comments anywhere in the tree; 2,232 were stripped. Rationale lives here and in the docs, never at the code site.
