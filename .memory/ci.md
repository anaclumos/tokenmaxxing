# CI and Nix

Traps in `.github/workflows/ci.yml` and the Nix modules. The release procedure is in `AGENTS.md` "Release and CI".

- The `Assign the version` step in `ci.yml` sets `shell: bash` so the runner adds `-o pipefail`, and a failed `curl` in its `curl | jq` read fails the step instead of reading as "version not listed" and triggering a second publish; a step with no `shell:` runs `bash -e {0}` without pipefail, so its pipeline reports only the last command.
- `magic-nix-cache-action` enables FlakeHub Cache whenever Determinate Nix is present and posts an `Unable to authenticate to FlakeHub` (`FlakeHub registration required`) annotation on every green run of a repository with no FlakeHub account, so the step keeps `use-flakehub: false`; do not drop the step (it serves the GitHub Actions cache) and do not add `id-token: write`, because FlakeHub Cache still needs an account.
- Verify a `nix/modules` change by evaluating the NixOS, Home Manager (Linux and macOS), and nix-darwin configurations on `main` and on the branch at one nixpkgs revision through `builtins.getFlake "git+file://<checkout>?rev=<sha>"` and comparing the system derivations; `getFlake` rejects a symlinked path (`is a symlink`). CI has no nixfmt step, so format with the `nixfmt` from `nix build .#formatter.x86_64-linux`.
