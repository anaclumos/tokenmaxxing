---
paths:
  - "docs/**"
---

# Docs site

- The docs site under `docs/` is a separate Next.js app with its own `bun.lock`: the Vercel Preview deployment status on the pull request head is the content check; the shipped check is the GitHub production deployment status on the merge commit, because the Vercel URLs are SSO-protected. Traps: the Supermemory documents with `project` `tokenmaxxing`.
