---
name: codex-sibling-reconcile-approved
description: "owner decisions 2026-07-20 - codex sibling reconcile (option b), WIDENED same day by in-session ruling to ALL pooled non-live siblings (healthy included): every sibling follows the live seat via signal + boundary promote"
metadata: 
  node_type: memory
  type: project
  originSessionId: 085f0c3d-1bd0-4a58-8930-8dfdcf1a0376
  modified: 2026-07-20T00:15:05.315Z
---

The iteration-3 review's finding 4 (codex sibling sessions keep running on an account that has become exhausted, presence files only prevent it being a swap TARGET) was resolved by the owner on 2026-07-20 via AskUserQuestion: implement option (b), RECONCILE. An exhausted sibling's supervisor should also respawn its session onto the live (best) account instead of letting it keep burning a depleted account until its own Stop hook happens to engage.

**Why:** codex cannot hot-swap, so a pool swap respawns only the deciding session; siblings ride their old account indefinitely. Presence files half-cover this (never target a running account) but nothing moves the sibling OFF a dead account. The prior stance (refuted-as-designed) was explicitly superseded by the owner's pick.

**WIDENED (owner ruling via AskUserQuestion, 2026-07-20, during round 7 / PR #35):** the reconcile covers ALL pooled non-live siblings, healthy included ("Reconcile all non-live"). Rationale accepted by the owner: codex refuses cross-account refreshes, so any non-live session wedges at token expiry regardless of quota; a safe-boundary respawn keeps the transcript and costs one visible restart. The sweep is named reconcileNonLiveSiblings; promotion revalidates only the DESTINATION (live seat pooled + usable), never the source seat's state. Unpooled seats stay untouched.

**How to apply:** the trigger must be CROSS-SESSION (hook correction 2026-07-20): waiting for the sibling's own Stop hook to DECIDE reproduces the burn the owner voted against. SHIPPED: PR #34 merged as squash 4a9cd2e (2026-07-20 05:05 KST, verified via gh pr view MERGED + main ff-pull) after two review rounds (7 findings fixed: self-skip removed with same-boundary self-rescue, post-swap re-sweep, cooldown-proof sweep, promotion usability revalidation, blank-sid guard, guarded post-swap re-sweep preserving swapped:true, promotion under the codex flock). Design as merged - signal + promote: any deciding actor's `evaluateAndMaybeSwapCodex` sweeps living presences BEFORE its engagement gate and drops `codex-reconcile/<supervisorId>` for siblings on exhausted/needs-reauth accounts, only while the live seat is usable; the sibling's own Stop hook then PROMOTES the signal into the normal respawn marker at its next turn boundary (the only safe respawn point), adding the session id its stdin alone carries - which dissolved the open session-id-persistence question (the id joins the marker at promotion; nothing persists it at spawn). Staleness guards: presence must still name the signaled account, live identity must differ from the sibling's own, no-sid boundaries retain the signal. All codex invariants preserved; no respawn-cost margin (dead/exhausted seat = hard-path class). Follow-up NOT implemented (separate policy call): healthy-but-non-live siblings still die eventually on the cross-account refresh refusal. Related: [[silence-is-not-approval-for-design-forks]].
