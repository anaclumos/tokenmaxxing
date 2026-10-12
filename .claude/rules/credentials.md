---
paths:
  - "src/lib/claude.ts"
  - "src/lib/codex.ts"
  - "src/lib/credstore.ts"
  - "src/lib/keychain.ts"
  - "src/lib/oauth.ts"
  - "src/lib/codexauth.ts"
  - "src/lib/codexoauth.ts"
  - "src/lib/grok.ts"
  - "src/lib/grokusage.ts"
  - "src/lib/decide.ts"
  - "src/lib/sample.ts"
  - "src/lib/state.ts"
  - "src/cli/add.ts"
  - "src/cli/auth.ts"
  - "src/cli/init.ts"
  - "src/cli/doctor.ts"
  - "src/cli/rm.ts"
  - "src/lib/pi.ts"
  - "src/lib/provider.ts"
  - "src/lib/statusonly.ts"
---

# Credentials and identity

- One Claude Code credential store per pooled account, `stores/<uuid8>/`, never one per session. A session runs on an account because the supervisor set `CLAUDE_SECURESTORAGE_CONFIG_DIR` to that store at spawn; the seat is fixed for the life of the process, and hooks, the statusline, and the CLI read it from the inherited variable (`seatFromEnv`), never from `~/.claude.json`, which Claude Code rewrites after whichever session refreshed last. Neither pool index carries an active account: `AccountsIndexSchema` is `{version: 2, accounts}`, and an older file that still holds `activeId` loads and drops the key on the next save.
- One Codex credential store per pooled account, `codex-stores/<uuid8>/`, never one per session. A session runs on an account because the supervisor set `CODEX_HOME` to that store at spawn; the seat is fixed for the life of the process, and the hook reads it from the inherited variable (`codexSeatFromEnv`). The store holds only `auth.json`: everything else is a symlink to the matching entry in the shared `~/.codex`, so sessions, history, and config stay shared and `codex resume` works across stores.
- tokenmaxxing writes a store once, at onboarding (`init`, `add`, `auth`: isolated login, owner verified through `fetchTokenIdentity`, harvested into the store), and never again. Claude Code's own refresh is the only writer afterwards, under the refresh lock it roots at the store, with its compare-and-swap on the refresh token. There is no tokenmaxxing refresh grant, no harvest, no park, no install, and no tokenmaxxing refresh lock: the onboarding reread runs unlocked after the login child has exited. Never copy a credential between stores or between hosts: a refresh rotation revokes the previous access token of that grant, so the other copy 401s, force-refreshes a superseded refresh token, gets `invalid_grant`, and Claude Code dead-clears it. Separate logins are separate grants and do not interfere, which is why the same accounts can be pooled on several hosts by logging in on each (`docs/content/docs/limitations.mdx`).
- Identity is the `accountUuid` that `fetchTokenIdentity` reports for a token (`GET /api/oauth/profile`), never the organization, never a stored label, and never a blob comparison. Team seats share one `organizationUuid`, so an org-keyed lookup collapses every seat onto the first one in the array. The check runs at onboarding (a login whose token belongs to another account than its identity file names changes nothing) and in `doctor`; a probe under a store needs no check, because only Claude Code writes the store.
- `isDeadCredential` (empty `accessToken` or `refreshToken`) is the one dead-grant signal: a dead store stamps `needsReauth` and the decision tries the next candidate (`InvalidGrantError` classifies as `dead-grant`); a missing or unreadable store is `StoreUnusableError`, skipped for the evaluation only (the `rejected` set in `decide.ts`). The set narrows only the candidate list, so one bad store never aborts an evaluation. `doctor` and the sampler judge a store by one predicate (`storeUsable`: present, parseable, not dead); `auth --all` walks every account that is flagged `needsReauth` or fails that predicate (`src/cli/auth.ts`), so a missing store, which never stamps the flag, is repaired too.
- Claude Code hashes the NFC-normalized `CLAUDE_SECURESTORAGE_CONFIG_DIR` into the macOS keychain item name whenever that variable is set, even with `CLAUDE_CONFIG_DIR` also set (`xSe` in the 2.1.269 binary); `isolatedTarget(storeDir)` names the same item. A missing namespaced item never falls back to the default one, so isolation is sound once the probe env is scrubbed and the intended store is set.
- The onboarding homes that hold plaintext credentials are the one hard-delete (`rmSync`) exception to the trash rule, so a live token never sits in the Trash.
- Grok quota is the weekly `creditUsagePercent` from `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` (`TOKENMAXXING_GROK_USAGE_URL` overrides). The dollar billing GET without `format=credits` is not quota: subscription accounts report `monthlyLimit` 0 there while credits remain. The credits body drops `creditUsagePercent` while the period's use is 0 (the proto3 JSON rule for a default scalar; the `{val: 0}` wrappers stay), so a body with `currentPeriod` and no percent reads as 0. tokenmaxxing does not refresh grok tokens; an expired stored access token is retried against the live `GROK_HOME` login when that login is the same account. A failed grok sample does not write the dollar body: an account with no stored window stays unmeasured, and one with a stored credits window keeps that figure as stale as it was.
