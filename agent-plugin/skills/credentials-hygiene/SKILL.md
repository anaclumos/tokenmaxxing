---
name: credentials-hygiene
description: Credential and identity rules for tokenmaxxing (fetchTokenIdentity account-uuid identity, flock, no blob compare, never print secrets). Use before any auth, swap, or credential-touching change.
---

# Credentials hygiene

## Identity

- Identity is the `accountUuid` that `fetchTokenIdentity` reports for a token (`GET /api/oauth/profile`), never the organization, never a stored label, and never a blob byte compare. Every seat of a Team plan shares one `organizationUuid`, so an org-keyed lookup collapses the seats onto one account. Two rotations of one account differ byte-for-byte.
- Park a credential under its token's real owner. Commit the active label in the same critical section as credential writes.
- Every live-store write goes through `withClaudeRefreshLock` (Claude). Near-expiry sessions can rotate into the live store at any moment.
- A refresh rotation revokes the previous access token at once, so refreshing any copy of a credential that is live elsewhere kills those sessions' token.

## Isolation

- Refuse ambient `CLAUDE_CONFIG_DIR` / `CLAUDE_SECURESTORAGE_CONFIG_DIR` in CLI, SDK, and MCP.
- A missing namespaced keychain item never falls back to the live one.
- Same accounts pooled on several hosts race on refresh (documented limitation).

## Agent hard stops

- No tool may return keychain blobs, `.credentials.json`, `auth.json`, or OAuth access/refresh tokens.
- Do not bypass Claude `/usage` with direct `GET /api/oauth/usage` (owner-rejected; 429s on the active session).
- Prefer MCP read tools; never `cat` credential paths into the transcript.

See [references/credentials.md](references/credentials.md).
