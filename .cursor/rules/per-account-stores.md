# Per-account credential stores

Invariants of the Claude seat model (issue #79) and what its hermetic verification taught.

- One store per pooled account, `stores/<uuid8>/`, set on a session as `CLAUDE_SECURESTORAGE_CONFIG_DIR` at spawn. Claude Code hashes that variable's NFC-normalized value into the macOS keychain item name whenever it is set, even with `CLAUDE_CONFIG_DIR` also set, and roots its refresh lock at the same directory; `isolatedTarget(storeDir)` names the same item.
- tokenmaxxing writes a store once, at onboarding, after the token's owner is verified through the profile endpoint. Claude Code's refresh is the only writer afterwards. A credential is never copied between stores, hosts, or Claude Code's default store: a refresh rotation revokes the previous access token of that grant and the other copy dies at its next refresh. Separate logins are separate grants and coexist.
- The seat is fixed for the life of a process. Hooks, the statusline, and the CLI read it from the inherited store variable; a respawn is a new process under another store. Nothing needs a swap clock, an adoption grace, or a cooldown on the Claude pool.
- A Claude move is a respawn marker written by the session's own hook at a turn boundary. The check tick has no seat and moves nothing; an unsupervised session gets enforced-limit stamps and nothing else.
- Placement and moves rank usable accounts by session-window headroom per session after placement, `(bar - used) / (sessions + 1)`, then pace pressure. The pick and the presence write share the pool lock, so concurrent launches see each other.
- A tee is ordered against the stored record by the sample time it carries, never by file mtime: Linux stamps mtime from the coarse clock, which can lag `Date.now()` by a tick, so a tee written right after its timestamp can read older than itself.
- A hermetic run of this model needs a stub `claude` that records its environment, answers `-p /usage` from a per-store fixture, and sleeps for interactive launches; the supervisor, hooks, `check`, and `status` then run end to end under a throwaway `HOME` and `TOKENMAXXING_HOME` with a synthetic version 2 pool, and store hashes before and after prove the credentials never moved.

See [switching policy](../../docs/content/docs/switching.mdx) and [credential storage](../../docs/content/docs/credentials.mdx).
