# Platform idioms

Verified against Bun 1.4.2, bun-types 1.3.14, and zod 4.4.3. Both move monthly; re-verify a line before relying on it.

- `Bun.stdin.text()` strips a leading UTF-8 BOM. The `Bun.stdin.stream()` plus `Buffer.concat` read keeps it, so `JSON.parse` fails on a BOM-prefixed payload under the stream read and succeeds under `text()`. The hook and statusline stdin readers keep the stream read so that a BOM-prefixed payload stays "no payload".
- `z.json()` output does not `.pipe()` into an object schema under TypeScript: `JSONType` is not assignable to an object input with optional keys. Parse text with `JsonTextSchema.safeParse(text).data` and hand the value to the target schema. A failed parse yields `undefined`, which every object schema rejects the same way as a `null` or `{}` sentinel.
- A zod codec whose `decode` throws propagates the exception out of `safeParse`. Push an issue through `ctx.issues` and return `z.NEVER` instead.
- `z.unknown()` is a required key in a zod 4 object schema. A key that may be absent needs `.optional()`.
- `node:util` `parseArgs` cannot reproduce the `main.ts` flag handling byte for byte: strict mode rejects subcommand-owned flags such as `auth --all`, and non-strict mode consumes `--` and stops stripping the three global flags after it. The three `includes` calls and the one `filter` stay.
- `Bun.TOML.parse` reads `cli_auth_credentials_store` the way codex does: a top-level key only, and a malformed file throws. A line scan also matches the key inside a `[table]` and tolerates a malformed file.
- `writeFileSync(fd, data)` loops over partial writes and encodes a string as UTF-8, so `writeFileAtomic` needs no write loop and no `TextEncoder`.
- `Bun.spawn` `timeout` with `killSignal` replaces a manual `setTimeout` kill. The timer dies with the child, and a throw before the child exits no longer leaves the child running.
