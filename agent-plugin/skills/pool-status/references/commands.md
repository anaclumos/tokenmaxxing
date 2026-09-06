# Status and list commands

- `tokenmaxxing` / `tokenmaxxing status`: sample and show bars; persists cached usage for the picker.
- `tokenmaxxing status --ping [--count N]`: DENIED for agents without explicit user approval. Meters every account, or N random ones under `--count`.
- `tokenmaxxing ls`: compact list.
- `tokenmaxxing watch [seconds]`: live re-render (default 120), never `--ping`.
- `--json` on any of these: one JSON document on stdout (`ok` mirrors the exit code); parse it instead of scraping the bars. `watch --json` prints one document per tick and never exits on its own.

Docs: `docs/content/docs/commands.mdx`.
