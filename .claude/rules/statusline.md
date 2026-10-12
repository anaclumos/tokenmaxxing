---
paths:
  - "src/entries/statusline.ts"
  - "src/entries/subagentstatusline.ts"
  - "src/lib/picker.ts"
  - "src/cli/status.ts"
  - "src/cli/render.ts"
  - "src/cli/serve.ts"
  - "src/cli/add.ts"
  - "src/cli/auth.ts"
---

# Statusline and displayed percents

- `src/entries/statusline.ts` renders natively and tees `usage/<uuid8>.json` for the session's seat (from the inherited store variable; no seat, no tee); subagent rows in `src/entries/subagentstatusline.ts`. Format spec in `docs/content/docs/statusline.mdx`. statusLine stdin sends top-level sub-objects as JSON `null`, so their schemas need `.nullable().optional()`, not `.optional()`. The main payload can never reflect the focused subagent; the subagent rows are the only such surface. This runs every turn, so keep it O(ms) and off flock and oauth: read the HEAD file, never spawn a git subprocess.
- Every displayed usage percent (statusline, `status` text and `bufferedPercentage`, the hub's `utilization`, `percent`, and `used_percent`, the `add`/`auth` note) comes from `bufferedUsed` in `picker.ts`, the one buffered formula over `barFor`, except in a status-only pool, which has no switch threshold and shows `liveUsed`. Decision sites (`isExhausted`, `blockedUntil`, `usableAt`, ranking, sampling cadence, `landWindows`, the tee, stored records) keep raw figures.
- Statusline formats already rejected: meter glyphs, Unicode fractions, dim or faint ANSI anywhere, account names, S/W window labels, percent signs, remaining-instead-of-used, usage numbers in color mode, and the counted parked collapse.
