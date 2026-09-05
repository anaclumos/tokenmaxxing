# Policy sources

- `docs/content/docs/switching.mdx`
- `src/lib/decide.ts`, `src/lib/picker.ts`
- `.memory/switch-policy-pace-pressure.md`

Default screening bars: session ladder [90] (a single rung; add lower rungs such as [50, 80, 95] to hand off earlier) with the active rung resolved per pool, weekly 98. Engagement floor 80. Wall defaults 100. Cooldown 45s on the automatic path after a swap. Check tick `policy.checkIntervalMs` (default 60000, minimum 10000); `init` writes it into the timer unit. Check cadence ceiling per rung: five ticks, three, two, then the one-tick floor, with the headroom bands at the same multiples (40 points sleeps five ticks, 20 three, 8 two, less every tick).
