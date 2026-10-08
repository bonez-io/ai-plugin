#!/usr/bin/env bash
# Tests that the Cursor and Codex legs carry what the creating-a-plugin skill and the new-plugin flow
# need: byte copies of the hash and push tools, the skill folder, and a flow written for the harness.
# The assertions live in tests/legs.test.mjs (Node's built-in runner); this wrapper gives CI and local
# runs the repo's one-entrypoint-per-test-file shape.
#
# Offline.
#
#     ./tests/test_legs.sh

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo "Running plugin-creator leg tests..."
node --test "$HERE/legs.test.mjs"
