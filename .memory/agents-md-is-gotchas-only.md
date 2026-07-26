---
name: agents-md-is-gotchas-only
description: 2026-07-26 - AGENTS.md was cut 88% (16,484 to ~2,000 words) to repo-specific gotchas only; everything else lives in DESIGN.md, docs/, .memory, or a comment at the code site
metadata:
  type: project
---

On 2026-07-26 AGENTS.md was cut from 292 lines / 16,484 words (~28k tokens loaded into EVERY session) to 104 lines / ~2,000 words, guided by Anthropic's "new rules of context engineering for Claude 5 generation models" (Anthropic removed 80%+ of Claude Code's own system prompt with no performance loss).

The cut was audited: every bullet was classified against the other doc surfaces, then all 358 proposed deletions were put to adversarial defenders. 341 were upheld and 17 refuted; the 17 rescued items were kept, which is why the file landed at ~2,000 words rather than the ~1,500 the first pass produced.

The standing rule for this file now: **repo-specific gotchas and quirks only**. Before adding anything, check it is not already stated in one of these, and if it is, link instead of inlining.

- The owner's global agent rules, which auto-load in the same session (never restate them here).
- `DESIGN.md` for architecture.
- `docs/content/docs/*.mdx` for anything operator-facing.
- `.memory/` for incidents, decisions, and verified third-party internals.
- A comment at the code site that could actually regress. This is the best home for an invariant: an agent editing that code sees it at the exact moment it matters.

**Why:** a 28k-token always-on file is expensive, but the worse problem is that a duplicated fact ROTS. Three verified drifts were found at cut time, each caused purely by duplication: the "Supervisor recursion guards" list enumerated guards a-e and missed the sixth (the on-disk spawn-rate limiter in `claudebin.ts`); the statusline note claimed `usage.ts` was kept off flock when it imports `lock.ts`; and "Outstanding test debt" claimed the 0.15.0 marker gate had no behavioral test after `test/stophook.test.ts` was written to pin exactly that. The file also carried ~1,900 words verbatim-duplicated from the global rules, seven internal contradictions, and facts restated up to eight times (identity-from-token appeared in eight places).

Two contradictions were actively harmful and are worth remembering as a class: the file said "Never use `typeof`. Use zod." while the codebase correctly uses `z.infer<typeof Schema>` 67 times, and banned standalone `type` while using `export type X = z.infer<...>` 62 times. Both were degraded copies of a global rule that carves out type-position `typeof` explicitly. **A rule an obedient agent would damage the codebase by following is worse than no rule.**

**How to apply:** when a session learns something durable, ask where it belongs before defaulting to AGENTS.md. Incidents and owner decisions go to `.memory` with an index line. Invariants go next to the code. Only a trap that is repo-specific, still true, and not visible from the code an agent is about to touch earns a line in AGENTS.md. See [[memory-is-public]] for what may not go in either.
