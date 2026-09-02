# Policy sources

- `docs/content/docs/switching.mdx`
- `src/lib/decide.ts`, `src/lib/picker.ts`
- `.memory/switch-policy-pace-pressure.md`

Default screening bars: session ladder [50, 80, 95] with the active rung resolved per pool, weekly 98. Wall defaults 100. Cooldown 45s on the automatic path after a swap. Check cadence ceiling per rung: 300s, 180s, 120s, then the 60s floor.
