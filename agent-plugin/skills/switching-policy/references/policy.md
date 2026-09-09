# Policy sources

- `docs/content/docs/switching.mdx`
- `src/lib/decide.ts`, `src/lib/picker.ts`
- `src/lib/bankedreset.ts`, `src/lib/codexreset.ts` (banked limit resets)
- `.cursor/rules/switch-verification.md`

Automatic organization preference requires session usage below `greedySessionFloor` and more than `max(1, session bar - greedySessionFloor)` points below every applicable bar.

The exact policy, defaults, verification limits and manual-switch behavior live in `docs/content/docs/switching.mdx`.
