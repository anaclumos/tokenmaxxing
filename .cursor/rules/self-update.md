# Self-update on the check tick

- The Bun global self-update runs `bun add -g tokenmaxxing@<version>` with no preceding `bun remove -g`. The `DependencyLoop` error recorded in `AGENTS.md` belongs to installing a local `.tgz` over an existing global, not to a registry version.
- `detectInstallKind` accepts only the canonical Bun global entry, with the root resolved as `BUN_INSTALL_GLOBAL_DIR`, then `BUN_INSTALL/install/global`, then `~/.bun/install/global`. A `bunfig.toml` `install.globalDir` is not read, so an install placed that way reads as `other` and never self-updates.
- The self-update runs after the evaluation and the parked sampler, outside the pool lock and the Claude refresh lock, so a stalled registry request never delays a swap.

See [build and distribution](../../docs/content/docs/distribution.mdx).
