#!/bin/sh
set -e
bun install --frozen-lockfile
bun run typecheck
d="$(mktemp -d)"
trap 'rm -r "$d"' EXIT
npm pack --pack-destination "$d"
tar -xzf "$d"/tokenmaxxing-*.tgz -C "$d" package/src/main.ts
test -x "$d/package/src/main.ts"
BUN_INSTALL_GLOBAL_DIR="$d/global" BUN_INSTALL_BIN="$d/bin" bun add -g "$d"/tokenmaxxing-*.tgz
"$d/bin/tokenmaxxing" help
