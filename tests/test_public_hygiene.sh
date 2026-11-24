#!/usr/bin/env bash
# Tests for scripts/check-public-hygiene.mjs, the check that keeps this public repository free of internal
# references. The assertions live in tests/public_hygiene.test.mjs (Node's built-in runner).
#
# Offline.
#
#     ./tests/test_public_hygiene.sh

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo "Running public-hygiene tests..."
node --test "$HERE/public_hygiene.test.mjs"
