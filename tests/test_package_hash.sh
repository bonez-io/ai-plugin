#!/usr/bin/env bash
# Tests for bin/bonez-package-hash.mjs (the Bonez plugin tree hash) and the plugin-creator template's
# build script. The assertions live in tests/package_hash.test.mjs (Node's built-in runner); this wrapper
# gives CI and local runs the repo's usual one-entrypoint-per-test-file shape.
#
# Offline. The template build case needs `bun` and skips itself when it is not installed.
#
#     ./tests/test_package_hash.sh

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo "Running bonez-package-hash.mjs tests..."
node --test "$HERE/package_hash.test.mjs"
