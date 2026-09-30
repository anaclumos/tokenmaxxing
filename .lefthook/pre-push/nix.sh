#!/bin/sh
set -e
d="$(mktemp -d)"
trap 'rm -r "$d"' EXIT
nix build --accept-flake-config .#tokenmaxxing -L --out-link "$d/result"
"$d/result/bin/tokenmaxxing" help
"$d/result/bin/xx" help >/dev/null
printf '{"thresholds":{"weekly":95}}\n' > "$d/config.json"
TOKENMAXXING_HOME="$d" "$d/result/bin/tokenmaxxing" config --json | jq -e '.ok == true and .effective.thresholds.weekly == 95 and .effective.thresholds.session == 90' >/dev/null
