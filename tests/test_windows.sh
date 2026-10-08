#!/usr/bin/env bash
# The Windows-portability tests: the shared tree-hash vectors through the hash and push tools, the
# Windows path normalisation, the line-ending and hook-command guards, and the fake-gateway push smoke
# test. The assertions live in tests/plugin_tree.test.mjs and tests/windows_portability.test.mjs (Node's
# built-in runner); the windows-latest job in .github/workflows/check.yml runs the same files with
# `node --test`. Offline.
#
#     ./tests/test_windows.sh

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo "Running Windows-portability tests..."
node --test "$HERE/plugin_tree.test.mjs" "$HERE/windows_portability.test.mjs"
node "$HERE/lib/push-smoke.mjs"
