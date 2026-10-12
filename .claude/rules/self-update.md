---
paths:
  - "src/lib/update.ts"
  - "src/cli/check.ts"
  - "src/lib/install.ts"
---

# Self-update on the check tick

- The global root is detected from the running entry: the first of `BUN_INSTALL_GLOBAL_DIR`, `BUN_INSTALL/install/global`, `dirname(dirname(process.execPath))/install/global`, and `~/.bun/install/global` whose `node_modules/tokenmaxxing/src/main.ts` is the real path of `Bun.main`, each `resolve`d against the check's own working directory (a relative `BUN_INSTALL_GLOBAL_DIR` would otherwise re-resolve against the child's `cwd`). `process.execPath` is the real binary path, never the invoked symlink. A `bunfig.toml` `install.globalDir` is not read, a root set only through `BUN_INSTALL_GLOBAL_DIR` is invisible to a timer that does not carry it, and a symlinked package directory (`bun link`) is unmanaged: all three never self-update.
- The version read and the install share one registry, the public one, with `--registry` passed to `bun add` because that flag overrides `.npmrc`, `bunfig.toml`, and the environment; `TOKENMAXXING_NPM_REGISTRY` overrides both for hermetic runs. The `latest` document's `engines.bun` is checked with `Bun.semver.satisfies` before the install, because `bun add -g` installs a package whose engine floor the running Bun fails and exits zero. The registry URL is built inside the update path, so a malformed override fails only the update attempt. Userinfo in the override becomes a `Basic` `Authorization` header on the version read only and is cleared from the URL, so ky and the install child's argv never carry credentials; the metadata read is bounded by `AbortSignal.timeout`. An authenticated-registry install reads its auth from Bun's own `bunfig.toml` or `.npmrc`.
- The self-update runs after the evaluation and the sampler, outside the pool lock, so a stalled registry request never delays a swap. The install child runs with `cwd` at the state directory and `BUN_INSTALL_GLOBAL_DIR` set to the detected root (`bun add` reads `bunfig.toml` from its working directory and the variable wins), is killed after 60 seconds (`Bun.spawn` `timeout` with `SIGKILL`, because launchd and systemd skip a firing while the previous check runs), and inherits stderr rather than piping it (a piped read stays pending while a descendant holds the pipe).
- Only the Claude `init` installs the check timer. A Codex-only install has no tick and no self-update; that ceiling is documented, not engineered around.
