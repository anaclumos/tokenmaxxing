---
name: hermetic-ladder-verification
description: How the ladder decision path is verified without a test suite and without touching live accounts, including the two dead-grant scenarios that need a stub OAuth server
metadata:
  type: project
---

Verified 2026-09-02 for 1.10.0. The repo carries no test code, so the decision path is exercised by running the real `check` against a throwaway state root. Two layers, in order of cost.

**Layer 1, no network.** Under `TOKENMAXXING_HOME=<dir>` write `accounts.json` (two accounts with `lastUsage` windows), `usage.json` for the live org, `config.json`, and a `claude.json` whose `oauthAccount` names the live account, then point `TOKENMAXXING_CLAUDE_JSON` at that claude.json and `TOKENMAXXING_KEYCHAIN_SERVICE` and `TOKENMAXXING_KEYCHAIN_ACCOUNT` at names that exist nowhere. Run `bun run src/main.ts check`. A hold prints the decision reason and the next-check delay; a hand-off is proven by the swap reaching for the sibling's parked credential and failing with `no parked credential for <email>`, since the throwaway keychain holds nothing. Scenarios covered this way: hand-off at 50 over a pace-winning seat, greedy hold at 80 (next check 180s), hand-off at 95, wall hold at 96 with the sibling at 97 (next check 60s).

**Layer 2, stub OAuth.** The dead-grant paths need a swap to run to completion, so credentials must exist and refresh. Run a small HTTP server in a separate process (an in-process server stalls behind `Bun.spawnSync`) and point `TOKENMAXXING_OAUTH_TOKEN_URL` and `TOKENMAXXING_OAUTH_ROLES_URL` at it: the token route answers HTTP 400 with `invalid_grant` for a refresh token on a dead list and a fresh access token otherwise, and the roles route derives `organization_uuid` from the bearer token so `fetchTokenOrg` maps the live credential back to its pool account. Seed three accounts whose `organizationUuid` is `org-<id>`, write the live blob under the throwaway service and account names and each parked blob under the account's `keychainItem` service with `security add-generic-password`, and give every blob an `expiresAt` hours out so the live token is not refreshed first. Delete every item afterwards and confirm `security find-generic-password -a <account>` exits 44.

| Scenario | Pool (5h used, weekly used) | Expected |
| --- | --- | --- |
| Dead grant climbs the rung | A live 55/60, B 30/80 dead, C 70/80 | `swap.invalid_grant B`, B stamped needs-reauth, rung climbs 50 to 80, A holds on the greedy path, `no switch (current-best) next in 180s`, live unchanged |
| Dead sibling then next | A live 96/60, B 30/80 dead, C 40/85 | `swap.invalid_grant B`, `swap.harvest A`, `swap.done C`, claude.json and accounts.json move to C, `next in 45s` |

**Why:** the review fix on the hard path (reload the pool after a dead grant, return to the greedy path when the rung climbs over the seat) is only observable with a refresh that fails, and the only safe way to fail a refresh is a stub. The keychain namespace keeps the run off the real `Claude Code-credentials` item; see [[live-pool-runs-need-permission]] for why nothing here may touch a pooled account, and [[fable-fanout-is-quota-spend]] for why verification stays hermetic.

**How to apply:** run Layer 1 for every decision-path change, Layer 2 whenever the swap or refresh code moves. Keep the harness in the session scratchpad, never in the repo, per the no-test-code ruling in AGENTS.md.
