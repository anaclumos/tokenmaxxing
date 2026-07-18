---
name: supervisor-recursion-guards
description: 2026-07-12 infinite bun self-spawn incident (poisoned claudeBin pin) and the layered guards shipped in 0.6.2
metadata:
  type: project
---

A user report (2026-07-13) confirmed unbounded wrapper recursion on 0.6.1: a v0.4.0-era install pinned a shim as config.json claudeBin; supervisor spawns it, the shim resolves `claude` from PATH back onto the wrapper, forever (~1800 bun processes, ~10/sec). Repro on HEAD confirmed via bounded shim harness. Archaeology: most plausible poisoning is tokenmaxxing's own stale wrapper - `ensurePathInRc` marker-idempotency keeps an OLD binDir on PATH after a TOKENMAXXING_HOME relocation, and init's PATH scan (exact-string binDir skip) pinned that stale wrapper. TOKENMAXXING_PROBE never prevented spawning, only session management; the 60s probe killer was defeated because descendants inherit the stdout pipe and `new Response(p.stdout).text()` waits for ALL holders (the forever-hung /usage probe).

**Why:** every guard was existence-based; nothing validated that "the real claude" actually was claude, and no spawn path was depth-bounded.

**How to apply:** the 0.6.2 layered guards (all in [[cc-codex-auth-mechanics]] territory): (a) TOKENMAXXING_WRAP_DEPTH env sentinel, supervisor aborts at 5, both spawn arms tag depth+1; (b) resolveRealClaude rejects candidates whose realpath parent is realpath(binDir); (c) probeUsage presets depth to the cap (a probe must never re-enter the wrapper); (d) verifyRealClaude (`--version`, 15s timeout, must print /claude/i) gates init pinning (resolveVerifiedClaude walks ALL PATH candidates) and doctor; (e) probe pipe reads race child-exit + 2s grace. User aliases like `cc`/`cco` with plain-`claude` bodies are supervised via PATH and fine; doctor warns on `alias claude=`/`claude()` shadowing and absolute-path bypass aliases. When adding ANY new spawn of "the real claude", spawn resolveRealClaude() output and preset the depth cap if that path must never re-enter the wrapper.
