# Status and list commands

- `tokenmaxxing` / `tokenmaxxing status`: sample and show bars; persists cached usage for the picker.
- `tokenmaxxing status --force`: DENIED for agents without explicit user approval. Meters every account.
- `tokenmaxxing ls`: compact list.
- `tokenmaxxing watch [seconds]`: live re-render (default 120), never `--force`.
- `--json` on any of these: one JSON document on stdout (`ok` mirrors the exit code); parse it instead of scraping the bars. `watch --json` prints one document per tick and never exits on its own.

Docs: `docs/content/docs/commands.mdx`.
