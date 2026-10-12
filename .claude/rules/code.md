---
paths:
  - "src/**"
---

# Code-wide constraints

- Env overrides parse through zod at the read site rather than a central `env.ts`, because the CLI's knobs are all optional. Unset parses to undefined and the feature degrades there.
- State files that exist but fail to parse THROW, so a truncated `accounts.json` can never read as an empty pool that `init` overwrites.
- A configured-but-missing path (`claudeBin`, `codexBin`, credential locations) fails fast. Never fall through to a PATH scan: the scan resolves the installed wrapper and recurses into it.
- Core deps are zod, es-toolkit, and ky. The global default stack does not apply (there is no date-fns here and no date helper: a reset time parses through zod at the read site, as ISO 8601 with an offset from the direct usage read and as epoch seconds through `EpochSecondsSchema` from the transcript row and the statusline stdin).
- Keep `node:fs`, which is Bun-native. `Bun.file`/`Bun.write` are async-only, non-atomic, and have no create-mode, so they cannot serve the 0600 credential store or the flock fd. When asked to simplify this, that is the answer.
- Verify an external tool's limits with a real-sized payload before relying on it: `security -i` truncates a 4KB blob silently.

## Platform idioms

Verified against Bun 1.4.x and zod 4.4.x; both move monthly, so re-verify a line before relying on it.

- `Bun.stdin.text()` strips a leading UTF-8 BOM; `Buffer.from(await Bun.stdin.bytes()).toString("utf8")` keeps it. The hook and statusline stdin readers share one bytes read (`readStdin` in `src/lib/proc.ts`) so a BOM-prefixed payload stays "no payload".
- Bun's `node:readline` ends a line at U+2028 as well as `\n` and `\r`, while `JSON.stringify` and serde_json leave U+2028 raw inside a string. The supervisor's stdin relay and the Codex app-server reader split on `\n` only (`readLines` in `src/lib/proc.ts`).
- The JSON text codec's output schema is `z.unknown()`, never `z.json()`: `z.json()` revalidates the parsed tree and rejects values `JSON.parse` accepts (`1e400` parses to `Infinity`), so it would turn a classifiable OAuth error body into an unclassified one, and it does not `.pipe()` into an object schema under TypeScript. Parse text with `JsonTextSchema.safeParse(text).data` and hand the value to the target schema: a failed parse yields `undefined`, which no target schema accepts.
- A zod codec whose `decode` throws propagates the exception out of `safeParse`. Push an issue through `ctx.issues` and return `z.NEVER` instead.
- `z.unknown()` is a required key in a zod 4 object schema. A key that may be absent needs `.optional()`.
- `node:util` `parseArgs` cannot reproduce the `main.ts` flag handling byte for byte: strict mode rejects subcommand-owned flags such as `auth --all`, and non-strict mode consumes `--` and stops stripping the global flags after it. The `includes` calls and the one `filter` stay.
- `Bun.TOML.parse` reads `cli_auth_credentials_store` the way codex does: a top-level key only, and a malformed file throws. The Codex hook trust check in `doctor` parses `config.toml` the same way and reports "unknown" for a file that does not parse.
- `z.stringbool()` reads an env flag: `1`, `true`, `yes`, `on`, `y`, and `enabled` are true, `0`, `false`, `no`, `off`, `n`, and `disabled` are false, and any other value throws. An empty value is unset because `optionalEnv` maps it to `undefined` first.
- `z.iso.datetime({ offset: true })` accepts `Z` and a numeric offset at any fractional-second precision, which covers the `resets_at` the usage read returns.
- `writeFileSync(fd, data)` loops over partial writes and encodes a string as UTF-8, so `writeFileAtomic` needs no write loop and no `TextEncoder`.
- ky's `timeout` and `totalTimeout` bound a request only until the response headers arrive; a body that stalls after them stays pending forever. `AbortSignal.timeout` passed as `signal` also aborts the body read, so a read whose body must be bounded (the usage read, the registry read) keeps the signal and never swaps it for `totalTimeout`.
- Bun sets `O_NONBLOCK` on a pipe or socket stdout the first time anything reads `process.stdout`, even `isTTY`, and a child spawned with `stdout: "inherit"` shares that open file, so a child that treats `EAGAIN` as fatal (codex's app-server stdio writer drops its connection on it) loses output. A child of a supervisor gets `childStdout()` (inherit only for a TTY, which Bun leaves blocking) and `relayStdout` copies a piped stdout with backpressure; the socket Bun gives a piped child is blocking. `runPassthrough` stops waiting on a reader that stopped reading once the wrapper gets SIGTERM, through a listener that only sets a flag, so every caller installs its own SIGTERM forward before it: a listener replaces the default exit.
- `Bun.spawn` `timeout` with `killSignal` replaces a manual `setTimeout` kill. The timer dies with the child, and a throw before the child exits no longer leaves the child running.

## Do not reintroduce

- A Stop-hook text-sniffing limit failsafe. Stop stdin carries no `is_error`, so it fires on turns that merely discuss limits and stamps healthy accounts as walled. The real errored-turn signal is the StopFailure hook (`src/entries/stopfailurehook.ts`): it classifies only the transcript row Claude Code itself marked `isApiErrorMessage`, never prose (the client's error text is prose too), attributes it to the seat the process runs under (fixed for the life of the process, so no swap clock or cooldown is needed), writes only `enforcedUntil` on the account, inside the decision's own critical section so the stamp and the candidate selection cannot interleave with another hook's stamp (no usage-window rewrite, no per-model stamp, no second enforcement field). A `kind: model` refusal does not stamp that field when the cached family window already screens until its own reset (`screensUntilReset`; a window that a `thresholds.accounts` release lets through earlier does not count): the window does the per-family screening, and the account stays usable for sessions that do not gate that family. The wall still lands when the cached row is missing or under the bar, or when a wall is already active. A usage-credits refusal (`kind: credits`) never stamps it. Keep it that way.
- A shared live credential for Claude, or anything that served it: harvest, park, install, a tokenmaxxing refresh grant, a `~/.claude.json` rewrite, a post-swap cooldown, a pool-wide depleted record, an ambient store-variable refusal, a manual Claude `switch`, or a copy of one grant in two stores. The Codex equivalents are gone too: the shared live `auth.json`, the parked `codex-creds/` copies, the pool-wide active label, the post-swap cooldown, the manual `switch --codex`, and the cross-session reconcile.
- The hold-to-wall banked reset (`preferToUseBankedReset`) and its measured session-window reserve, the session ladder, the greedy engagement floor, the incumbent swap margin, the self-paced check cadence, `status --ping`, the SDK surface, the MCP server, and the agent plugin. Each is deleted; the CLI, the hooks, the supervisor, and the hub are the only surfaces.
- Statusline formats already rejected: see `statusline.md`.
- Compatibility bridges, migration shims, or dual behavior for old local states.
- The Cursor Cloud relay and its setup tokens: `setup-token`, `cursor init`, `cloud run`, `setup-tokens.json`, `TOKENMAXXING_TOKENS`, and the `cloud/` state.
