#!/usr/bin/env bash
# Tests for bin/bonez-session-sync.mjs — the plugin-side companion to tests/test_gate.sh.
#
# The actual assertions live in tests/session_sync.test.mjs (Node's built-in test runner:
# gzip/NDJSON bundle inspection and a local stub HTTP gateway are impractical in pure bash,
# unlike the string-matching gate-write.sh tests). This wrapper exists so CI and local runs
# have one consistent entrypoint per test file, matching the repo's tests/test_*.sh convention.
#
# Run from anywhere:
#
#     ./tests/test_session_sync.sh

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo "Running bonez-session-sync.mjs tests..."
node --test "$HERE/session_sync.test.mjs"
