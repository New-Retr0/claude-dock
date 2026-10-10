#!/usr/bin/env bash
# Runs each plugin's tests. `claude plugin test` only finds tests inside a plugin's folder, but the tests
# stay out of the folders people install, so each run copies a plugin and its tests to a scratch folder.
# Usage: scripts/test.sh [plugin ...]   (default: every plugin with a folder under tests/)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -gt 0 ]; then plugins=("$@"); else plugins=(); for d in "$root"/tests/*/; do plugins+=("$(basename "$d")"); done; fi
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
status=0
for plugin in "${plugins[@]}"; do
  [ -d "$root/$plugin" ] && [ -d "$root/tests/$plugin" ] || { echo "no plugin or tests named $plugin"; exit 2; }
  cp -R "$root/$plugin" "$scratch/$plugin"
  cp -R "$root/tests/$plugin" "$scratch/$plugin/tests"
  echo "== $plugin"
  claude plugin test "$scratch/$plugin" || status=1
done
exit "$status"
